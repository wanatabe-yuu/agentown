// agentownctl sets up and operates an Agentown cluster on VMs you already
// have, over SSH, from your own machine.
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Set at build time: -ldflags "-X main.version=v0.1.0"
var version = "dev"

const usage = `agentownctl: set up and operate an Agentown cluster on your own VMs over SSH.

Usage:
  agentownctl init                  write an example agentown.cluster.yaml
  agentownctl up [--force]          install or upgrade the server, join the nodes
  agentownctl status                server health, nodes and agent pods
  agentownctl ui [--port 8080]      open an SSH tunnel to the web UI
  agentownctl token                 print the owner token
  agentownctl logs [-n 100] [-f]    server log
  agentownctl ssh [NODE]            shell on the server (or a node)
  agentownctl version

Every command reads the cluster file from -c FILE, $AGENTOWN_CLUSTER, or
./agentown.cluster.yaml. SSH uses your own keys, agent and ~/.ssh/config.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		var code exitCode
		if errors.As(err, &code) {
			os.Exit(int(code))
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit %d", int(e)) }

func run(args []string) error {
	if len(args) == 0 {
		fmt.Print(usage)
		return nil
	}
	cmd, rest := args[0], args[1:]
	fs := flag.NewFlagSet("agentownctl "+cmd, flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	defaultFile := os.Getenv("AGENTOWN_CLUSTER")
	if defaultFile == "" {
		defaultFile = "agentown.cluster.yaml"
	}
	file := fs.String("c", defaultFile, "cluster file")

	switch cmd {
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	case "version", "--version":
		fmt.Println("agentownctl", version)
		return nil
	case "init":
		if err := fs.Parse(rest); err != nil {
			return err
		}
		if _, err := os.Stat(*file); err == nil {
			return fmt.Errorf("%s already exists", *file)
		}
		if err := os.WriteFile(*file, []byte(exampleCluster), 0o644); err != nil {
			return err
		}
		fmt.Printf("wrote %s: set server.host (and nodes), then run: agentownctl up\n", *file)
		return nil
	case "up":
		force := fs.Bool("force", false, "re-run the installer even if the server is up to date")
		if err := fs.Parse(rest); err != nil {
			return err
		}
		c, err := LoadCluster(*file)
		if err != nil {
			return err
		}
		return up(c, *force)
	case "status":
		c, err := loadWith(fs, rest, file)
		if err != nil {
			return err
		}
		_, err = runScript(c.Server, statusScript, runOpts{Stream: true, What: "status"})
		return err
	case "token":
		c, err := loadWith(fs, rest, file)
		if err != nil {
			return err
		}
		tok, err := capture(c.Server, `cat /var/lib/agentown/owner-token`, "reading the owner token")
		if err != nil {
			return err
		}
		fmt.Println(tok)
		return nil
	case "ui":
		port := fs.Int("port", 8080, "local port")
		c, err := loadWith(fs, rest, file)
		if err != nil {
			return err
		}
		fmt.Printf("Agentown UI: http://localhost:%d  (sign in with: agentownctl token)\nTunnel to %s open; Ctrl-C to close.\n", *port, c.Server.Host)
		code, err := interactive(c.Server, sshOpts{Forward: fmt.Sprintf("127.0.0.1:%d:127.0.0.1:8080", *port)}, "")
		if err == nil && code != 0 {
			return exitCode(code)
		}
		return err
	case "logs":
		lines := fs.Int("n", 100, "number of lines")
		follow := fs.Bool("f", false, "follow")
		c, err := loadWith(fs, rest, file)
		if err != nil {
			return err
		}
		remote := fmt.Sprintf("sudo -n journalctl -u agentown --no-pager -n %d", *lines)
		if *follow {
			remote += " -f"
		}
		code, err := interactive(c.Server, sshOpts{TTY: *follow}, remote)
		if err == nil && code != 0 {
			return exitCode(code)
		}
		return err
	case "ssh":
		c, err := loadWith(fs, rest, file)
		if err != nil {
			return err
		}
		t := c.Server
		if name := fs.Arg(0); name != "" && name != "server" {
			found := false
			for _, n := range c.Nodes {
				if n.Label == name {
					t, found = n.Target, true
				}
			}
			if !found {
				return fmt.Errorf("no node named %q in %s", name, c.File)
			}
		}
		code, err := interactive(t, sshOpts{TTY: true}, "")
		if err == nil && code != 0 {
			return exitCode(code)
		}
		return err
	default:
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func loadWith(fs *flag.FlagSet, rest []string, file *string) (*Cluster, error) {
	if err := fs.Parse(rest); err != nil {
		return nil, err
	}
	return LoadCluster(*file)
}

func step(format string, a ...any) { fmt.Printf("\n==> "+format+"\n", a...) }

// up converges the cluster to the file: server installed at the wanted
// release with the wanted org config, every node joined, labelled and
// holding the agent image. Safe to run again.
func up(c *Cluster, force bool) error {
	all := []Target{c.Server}
	for _, n := range c.Nodes {
		all = append(all, n.Target)
	}

	step("Checking %d machine(s)", len(all))
	facts := make([]map[string]string, len(all))
	errs := make([]error, len(all))
	var wg sync.WaitGroup
	for i, t := range all {
		wg.Add(1)
		go func(i int, t Target) {
			defer wg.Done()
			out, err := runScript(t, factsScript, runOpts{What: "SSH and passwordless sudo check"})
			facts[i], errs[i] = parseKV(out), err
		}(i, t)
	}
	wg.Wait()
	var problems []string
	for i, t := range all {
		if errs[i] != nil {
			problems = append(problems, errs[i].Error())
			continue
		}
		for _, p := range checkFacts(facts[i]) {
			problems = append(problems, fmt.Sprintf("%s (%s): %s", t.Label, t.Host, p))
		}
		if i > 0 && facts[i]["k3s_server"] == "active" {
			problems = append(problems, fmt.Sprintf("%s (%s): already runs a k3s server; a node must be a separate machine", t.Label, t.Host))
		}
		if i > 0 && t.Host == c.Server.Host && t.Port == c.Server.Port {
			problems = append(problems, fmt.Sprintf("%s: same host as the server", t.Label))
		}
	}
	if len(problems) > 0 {
		return errors.New("cannot continue:\n  " + strings.Join(problems, "\n  "))
	}
	for i, t := range all {
		f := facts[i]
		state := "fresh"
		if f["installed"] != "" {
			state = "agentown " + f["installed"]
		} else if f["k3s_agent"] == "active" {
			state = "k3s agent " + f["k3s"]
		}
		fmt.Printf("  %-12s %-20s ubuntu %s, %s, ip %s, %s\n", t.Label, t.Host, f["os_version"], f["arch"], f["ip"], state)
	}
	sf := facts[0]

	tag := c.Version
	if tag == "latest" {
		out, err := capture(c.Server, latestTagScript(c.Repo), "looking up the latest release")
		if err != nil {
			return err
		}
		if out == "" {
			return fmt.Errorf("no published release found in %s", c.Repo)
		}
		tag = out
	}

	orgChanged := false
	if c.OrgPath != "" {
		data, err := os.ReadFile(c.OrgPath)
		if err != nil {
			return fmt.Errorf("org config: %w", err)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != sf["org_sha256"] {
			step("Uploading org config %s", c.OrgPath)
			if _, err := runScript(c.Server, uploadOrgScript(base64.StdEncoding.EncodeToString(data)), runOpts{Stream: true, What: "uploading the org config"}); err != nil {
				return err
			}
			orgChanged = true
		}
	}

	if force || orgChanged || sf["installed"] != tag {
		step("Installing Agentown %s on the server (%s driver)", tag, c.Driver)
		url := c.InstallURL
		if url == "" {
			url = fmt.Sprintf("https://github.com/%s/releases/download/%s/install.sh", c.Repo, tag)
		}
		if _, err := runScript(c.Server, installScript(url, tag, c.Driver, c.Repo), runOpts{Stream: true, What: "the installer"}); err != nil {
			return err
		}
	} else {
		step("Server already runs %s", tag)
	}

	if c.Driver == "kubernetes" {
		if err := joinNodes(c, sf["hostname"], facts[1:]); err != nil {
			return err
		}
	}

	step("Done")
	fmt.Printf(`  Agentown %s is running on %s.

  agentownctl status     server health, nodes and agent pods
  agentownctl ui         open the web UI at http://localhost:8080
  agentownctl token      the owner token to sign in with
`, tag, c.Server.Host)
	return nil
}

func joinNodes(c *Cluster, serverNode string, nodeFacts []map[string]string) error {
	info, err := capture(c.Server, joinInfoScript, "reading the k3s join token")
	if err != nil {
		return err
	}
	kv := parseKV(info)
	token, image := kv["token"], kv["image"]
	k3sVersion, err := capture(c.Server, `k3s --version | awk 'NR==1{print $3}'`, "reading the k3s version")
	if err != nil {
		return err
	}
	if len(c.Nodes) > 0 && (token == "" || image == "" || k3sVersion == "") {
		return errors.New("server is missing the k3s join token, the agent image or k3s itself; re-run with --force")
	}
	serverAddr := c.InternalAddress
	if serverAddr == "" {
		serverAddr, err = capture(c.Server, `ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}'`, "detecting the server address")
		if err != nil {
			return err
		}
	}

	for i, n := range c.Nodes {
		step("Node %s (%s, %s pool)", n.Label, n.Host, n.Pool)
		if nodeFacts[i]["k3s_agent"] != "active" {
			if _, err := runScript(n.Target, joinNodeScript(serverAddr, token, k3sVersion, n.Label, n.Pool), runOpts{Stream: true, What: "joining the cluster"}); err != nil {
				return err
			}
		}
		if _, err := runScript(c.Server, settleNodeScript(n.Label, n.Pool), runOpts{Stream: true, What: "waiting for node " + n.Label}); err != nil {
			return err
		}
		has, err := capture(n.Target, hasImageScript(image), "checking the agent image")
		if err != nil {
			return err
		}
		if has != "yes" {
			fmt.Printf("[%s] copying %s from the server\n", n.Label, image)
			if err := pipeBetween(c.Server, "k3s ctr -n k8s.io images export - "+shq(image), n.Target, "k3s ctr -n k8s.io images import -"); err != nil {
				return err
			}
		}
	}

	// Nodes in the cluster that the file no longer lists are left alone, but reported.
	names, err := capture(c.Server, nodeNamesScript, "listing nodes")
	if err != nil {
		return err
	}
	known := map[string]bool{serverNode: true}
	for _, n := range c.Nodes {
		known[n.Label] = true
	}
	var extra []string
	for _, name := range strings.Fields(names) {
		if !known[name] {
			extra = append(extra, name)
		}
	}
	if len(extra) > 0 {
		fmt.Printf("\nnote: the cluster also has nodes not in %s: %s (left unchanged)\n", c.File, strings.Join(extra, ", "))
	}
	return nil
}
