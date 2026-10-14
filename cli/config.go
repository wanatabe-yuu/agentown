package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// The cluster file (agentown.cluster.yaml): which existing VMs make up the
// cluster and how to reach them over SSH. agentownctl never creates VMs.

type sshDefaults struct {
	User         string `yaml:"user"`
	Port         int    `yaml:"port"`
	IdentityFile string `yaml:"identityFile"`
}

type hostSpec struct {
	Host         string `yaml:"host"`
	User         string `yaml:"user"`
	Port         int    `yaml:"port"`
	IdentityFile string `yaml:"identityFile"`
}

type serverSpec struct {
	hostSpec        `yaml:",inline"`
	InternalAddress string `yaml:"internalAddress"`
}

type nodeSpec struct {
	hostSpec `yaml:",inline"`
	Name     string `yaml:"name"`
	Pool     string `yaml:"pool"`
}

type clusterFile struct {
	Name       string      `yaml:"name"`
	Version    string      `yaml:"version"`
	Driver     string      `yaml:"driver"`
	Repo       string      `yaml:"repo"`
	Org        string      `yaml:"org"`
	SSH        sshDefaults `yaml:"ssh"`
	Server     serverSpec  `yaml:"server"`
	Nodes      []nodeSpec  `yaml:"nodes"`
	InstallURL string      `yaml:"installUrl"`
}

// Target is one VM, with SSH defaults applied.
type Target struct {
	Label        string // "server" or the node name
	Host         string
	User         string
	Port         int
	IdentityFile string
}

type NodeTarget struct {
	Target
	Pool string // shared | dedicated
}

type Cluster struct {
	File            string
	Name            string
	Version         string // "latest" or a tag
	Driver          string // kubernetes | docker
	Repo            string
	OrgPath         string
	InstallURL      string
	InternalAddress string
	Server          Target
	Nodes           []NodeTarget
}

var (
	reName     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	reHost     = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,253}$`)
	reUser     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`)
	reVersion  = regexp.MustCompile(`^(latest|v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?)$`)
	reRepo     = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	reURLHTTPS = regexp.MustCompile(`^https?://\S+$`)
)

func expandPath(p, base string) string {
	if p == "" {
		return ""
	}
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[2:])
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(base, p)
	}
	return p
}

// ParseCluster validates a cluster file and applies defaults.
func ParseCluster(data []byte, file string) (*Cluster, error) {
	var f clusterFile
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("invalid cluster file %s: %w", file, err)
	}

	var problems []string
	bad := func(field, msg string) { problems = append(problems, fmt.Sprintf("  %s: %s", field, msg)) }

	if f.Name == "" {
		f.Name = "agentown"
	}
	if f.Version == "" {
		f.Version = "latest"
	}
	if f.Driver == "" {
		f.Driver = "kubernetes"
	}
	if f.Repo == "" {
		f.Repo = "wanatabe-yuu/Agentown"
	}
	if !reName.MatchString(f.Name) {
		bad("name", "lowercase letters, digits and dashes")
	}
	if !reVersion.MatchString(f.Version) {
		bad("version", `must be "latest" or a tag like v0.1.0`)
	}
	if f.Driver != "kubernetes" && f.Driver != "docker" {
		bad("driver", "must be kubernetes or docker")
	}
	if !reRepo.MatchString(f.Repo) {
		bad("repo", "must look like owner/name")
	}
	if f.InstallURL != "" && !reURLHTTPS.MatchString(f.InstallURL) {
		bad("installUrl", "must be an http(s) URL")
	}
	checkHost := func(field string, h hostSpec) {
		if h.Host == "" {
			bad(field+".host", "required")
		} else if !reHost.MatchString(h.Host) {
			bad(field+".host", "must be a hostname or IP address")
		}
		if h.User != "" && !reUser.MatchString(h.User) {
			bad(field+".user", "not a valid user name")
		}
		if h.Port < 0 || h.Port > 65535 {
			bad(field+".port", "must be 1-65535")
		}
	}
	if f.SSH.User != "" && !reUser.MatchString(f.SSH.User) {
		bad("ssh.user", "not a valid user name")
	}
	if f.SSH.Port < 0 || f.SSH.Port > 65535 {
		bad("ssh.port", "must be 1-65535")
	}
	checkHost("server", f.Server.hostSpec)
	if f.Server.InternalAddress != "" && !reHost.MatchString(f.Server.InternalAddress) {
		bad("server.internalAddress", "must be a hostname or IP address")
	}
	if f.Driver == "docker" && len(f.Nodes) > 0 {
		bad("nodes", "extra nodes need driver: kubernetes")
	}
	seen := map[string]bool{}
	for i := range f.Nodes {
		n := &f.Nodes[i]
		field := fmt.Sprintf("nodes[%d]", i)
		checkHost(field, n.hostSpec)
		if n.Name == "" {
			n.Name = fmt.Sprintf("node-%d", i+1)
		}
		if !reName.MatchString(n.Name) {
			bad(field+".name", "lowercase letters, digits and dashes")
		}
		if seen[n.Name] {
			bad(field+".name", "duplicate node name "+n.Name)
		}
		seen[n.Name] = true
		if n.Pool == "" {
			n.Pool = "shared"
		}
		if n.Pool != "shared" && n.Pool != "dedicated" {
			bad(field+".pool", "must be shared or dedicated")
		}
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("invalid cluster file %s:\n%s", file, strings.Join(problems, "\n"))
	}

	base := filepath.Dir(file)
	if abs, err := filepath.Abs(file); err == nil {
		base = filepath.Dir(abs)
	}
	target := func(h hostSpec, label string) Target {
		t := Target{Label: label, Host: h.Host, User: h.User, Port: h.Port, IdentityFile: h.IdentityFile}
		if t.User == "" {
			t.User = f.SSH.User
		}
		if t.Port == 0 {
			t.Port = f.SSH.Port
		}
		if t.IdentityFile == "" {
			t.IdentityFile = f.SSH.IdentityFile
		}
		t.IdentityFile = expandPath(t.IdentityFile, base)
		return t
	}
	c := &Cluster{
		File:            file,
		Name:            f.Name,
		Version:         f.Version,
		Driver:          f.Driver,
		Repo:            f.Repo,
		OrgPath:         expandPath(f.Org, base),
		InstallURL:      f.InstallURL,
		InternalAddress: f.Server.InternalAddress,
		Server:          target(f.Server.hostSpec, "server"),
	}
	for _, n := range f.Nodes {
		c.Nodes = append(c.Nodes, NodeTarget{Target: target(n.hostSpec, n.Name), Pool: n.Pool})
	}
	return c, nil
}

func LoadCluster(file string) (*Cluster, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return ParseCluster(data, file)
}

const exampleCluster = `# Agentown cluster: existing VMs that agentownctl sets up over SSH.
# Each VM: Ubuntu 24.04 x86_64, SSH key login, passwordless sudo.
# Between the VMs allow TCP 6443, 8080, 10250 and UDP 8472 (k3s + agent API).

name: agentown
version: latest          # or a release tag, e.g. v0.1.0
driver: kubernetes       # kubernetes (k3s) or docker (single VM, no extra nodes)

ssh:                     # defaults for every host
  user: ubuntu
  # identityFile: ~/.ssh/id_ed25519
  # port: 22

server:                  # runs the Agentown server, PostgreSQL and the k3s control plane
  host: 203.0.113.10
  # internalAddress: 10.148.0.2   # private IP the nodes use (default: detected)

nodes: []                # extra machines for agents
#  - host: 203.0.113.11
#    pool: shared         # many agents per node
#  - host: 203.0.113.12
#    pool: dedicated      # one agent per node (presets with placement: dedicated-node)

# org: ./agentown.yaml   # your org config (departments, templates, permissions)
`
