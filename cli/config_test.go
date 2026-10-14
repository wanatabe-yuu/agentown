package main

import (
	"strings"
	"testing"
)

func TestParseClusterDefaults(t *testing.T) {
	c, err := ParseCluster([]byte(`
ssh: { user: ubuntu, port: 2222, identityFile: keys/id }
server: { host: 10.0.0.1 }
nodes:
  - host: 10.0.0.2
  - host: 10.0.0.3
    pool: dedicated
    user: root
`), "/work/agentown.cluster.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if c.Name != "agentown" || c.Version != "latest" || c.Driver != "kubernetes" || c.Repo != "wanatabe-yuu/Agentown" {
		t.Fatalf("defaults not applied: %+v", c)
	}
	if c.Server.User != "ubuntu" || c.Server.Port != 2222 || c.Server.IdentityFile != "/work/keys/id" {
		t.Fatalf("ssh defaults not applied to server: %+v", c.Server)
	}
	if len(c.Nodes) != 2 || c.Nodes[0].Label != "node-1" || c.Nodes[0].Pool != "shared" {
		t.Fatalf("node defaults: %+v", c.Nodes)
	}
	if c.Nodes[1].Pool != "dedicated" || c.Nodes[1].User != "root" {
		t.Fatalf("node overrides: %+v", c.Nodes[1])
	}
}

func TestParseClusterRejects(t *testing.T) {
	cases := map[string]string{
		"missing server":       `nodes: []`,
		"unknown field":        "server: { host: a }\nsevrer: {}",
		"bad version":          "version: 1.0\nserver: { host: a }",
		"bad pool":             "server: { host: a }\nnodes: [{ host: b, pool: big }]",
		"docker with nodes":    "driver: docker\nserver: { host: a }\nnodes: [{ host: b }]",
		"duplicate node names": "server: { host: a }\nnodes: [{ host: b, name: x }, { host: c, name: x }]",
		"shell in host":        "server: { host: 'a; rm -rf /' }",
		"bad user":             "ssh: { user: 'a b' }\nserver: { host: a }",
		"plain http installer": "server: { host: a }\ninstallUrl: http://example.com/install.sh",
	}
	for name, doc := range cases {
		if _, err := ParseCluster([]byte(doc), "f.yaml"); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestExampleParses(t *testing.T) {
	c, err := ParseCluster([]byte(exampleCluster), "agentown.cluster.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.Host == "" || !strings.HasPrefix(c.Version, "latest") {
		t.Fatalf("example: %+v", c)
	}
}

func TestInstallURL(t *testing.T) {
	for _, ok := range []string{"https://example.com/install.sh", "http://127.0.0.1:8999/install.sh", "http://localhost/install.sh"} {
		if _, err := ParseCluster([]byte("server: { host: a }\ninstallUrl: "+ok), "f.yaml"); err != nil {
			t.Errorf("%s should be accepted: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://example.com/install.sh", "http://127.0.0.1.evil.com/x", "ftp://example.com/x", "file:///tmp/x"} {
		if _, err := ParseCluster([]byte("server: { host: a }\ninstallUrl: "+bad), "f.yaml"); err == nil {
			t.Errorf("%s should be rejected", bad)
		}
	}
}
