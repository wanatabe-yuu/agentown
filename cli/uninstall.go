package main

import (
	"bufio"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"strings"
)

// uninstallScript is deploy/uninstall.sh, embedded so that uninstall works on
// servers whose installed release predates it. TestUninstallScriptInSync keeps
// the copy identical to the original.
//
//go:embed uninstall.sh
var uninstallScript string

// uninstall removes Agentown from the server (and, with all, k3s and the other
// components the installer added) and cleans the nodes.
func uninstall(c *Cluster, all, yes bool) error {
	fmt.Printf("This removes Agentown and ALL of its data from cluster %q:\n", c.Name)
	fmt.Printf("  server  %s: service, files, database, agents, owner token, secret-key\n", c.Server.Host)
	for _, n := range c.Nodes {
		if all {
			fmt.Printf("  node    %s (%s): k3s agent and everything it holds\n", n.Label, n.Host)
		} else {
			fmt.Printf("  node    %s (%s): the agent image\n", n.Label, n.Host)
		}
	}
	if all {
		fmt.Println("  --all:  also k3s, PostgreSQL (every database on the server), Node.js and Docker,")
		fmt.Println("          where the installer added them")
	}
	fmt.Println("Stored API keys cannot be recovered afterwards.")
	if !yes {
		fmt.Printf("\nType the cluster name (%s) to continue: ", c.Name)
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return errors.New("aborted, nothing was changed (no confirmation; use --yes in scripts)")
		}
		if strings.TrimSpace(line) != c.Name {
			return errors.New("aborted, nothing was changed")
		}
	}

	args := "--yes"
	if all {
		args += " --all"
	}
	step("Removing Agentown from the server")
	if _, err := runScript(c.Server, "set -- "+args+"\n"+uninstallScript, runOpts{Stream: true, What: "uninstall"}); err != nil {
		return err
	}

	var failed []string
	for _, n := range c.Nodes {
		step("Cleaning node %s (%s)", n.Label, n.Host)
		script := `for ref in $(k3s ctr -n k8s.io images ls -q 2>/dev/null | grep -E '(^|/)agentown/harness:' || true); do k3s ctr -n k8s.io images rm "$ref" >/dev/null; done; echo "agent image removed"`
		if all {
			script = `if [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then /usr/local/bin/k3s-agent-uninstall.sh >/dev/null 2>&1; echo "k3s agent uninstalled"; else echo "no k3s agent on this node"; fi`
		}
		if _, err := runScript(n.Target, script, runOpts{Stream: true, What: "cleaning the node"}); err != nil {
			failed = append(failed, err.Error())
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("server cleaned, but some nodes failed:\n  %s", strings.Join(failed, "\n  "))
	}
	step("Done")
	fmt.Printf("  Agentown has been removed from cluster %q. %s is still yours to delete.\n", c.Name, c.File)
	return nil
}
