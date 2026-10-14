package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Everything remote goes through the system OpenSSH client, so the user's
// keys, agent and ~/.ssh/config apply. Scripts are sent on stdin to
// `sudo -n bash -s`, never interpolated into the command line.

func sshBin() string {
	if b := os.Getenv("AGENTOWN_SSH"); b != "" {
		return b
	}
	return "ssh"
}

type sshOpts struct {
	TTY     bool
	Forward string // -L spec; implies -N
}

func sshArgs(t Target, o sshOpts) []string {
	a := []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"}
	if o.TTY {
		a = append(a, "-t")
	}
	if o.Forward != "" {
		a = append(a, "-N", "-L", o.Forward, "-o", "ExitOnForwardFailure=yes")
	}
	if t.Port != 0 {
		a = append(a, "-p", strconv.Itoa(t.Port))
	}
	if t.IdentityFile != "" {
		a = append(a, "-i", t.IdentityFile, "-o", "IdentitiesOnly=yes")
	}
	if t.User != "" {
		a = append(a, t.User+"@"+t.Host)
	} else {
		a = append(a, t.Host)
	}
	return a
}

// shq quotes a value for a POSIX shell.
func shq(v string) string { return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'" }

// withVars prepends KEY='value' assignments (sorted, for stable output) to a script.
func withVars(vars map[string]string, script string) string {
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%s\n", k, shq(vars[k]))
	}
	b.WriteString(script)
	return b.String()
}

// RemoteError carries the output of a failed remote script.
type RemoteError struct {
	Target Target
	What   string
	Code   int
	Output string
}

func (e *RemoteError) Error() string {
	lines := strings.Split(strings.TrimSpace(e.Output), "\n")
	if len(lines) > 8 {
		lines = lines[len(lines)-8:]
	}
	msg := fmt.Sprintf("%s (%s): %s failed (exit %d)", e.Target.Label, e.Target.Host, e.What, e.Code)
	if tail := strings.TrimSpace(strings.Join(lines, "\n")); tail != "" {
		msg += "\n" + tail
	}
	return msg
}

// prefixWriter writes complete lines to w, each prefixed (e.g. "[server] ").
type prefixWriter struct {
	mu     *sync.Mutex
	w      io.Writer
	prefix string
	buf    []byte
}

func (p *prefixWriter) Write(b []byte) (int, error) {
	p.buf = append(p.buf, b...)
	for {
		i := bytes.IndexByte(p.buf, '\n')
		if i < 0 {
			break
		}
		p.mu.Lock()
		fmt.Fprintf(p.w, "%s%s\n", p.prefix, p.buf[:i])
		p.mu.Unlock()
		p.buf = p.buf[i+1:]
	}
	return len(b), nil
}

func (p *prefixWriter) Flush() {
	if len(p.buf) > 0 {
		p.mu.Lock()
		fmt.Fprintf(p.w, "%s%s\n", p.prefix, p.buf)
		p.mu.Unlock()
		p.buf = nil
	}
}

var outputMu sync.Mutex

type runOpts struct {
	Stream bool   // print output live with a host prefix
	What   string // for error messages
}

// runScript runs a bash script as root on the target and returns its stdout.
func runScript(t Target, script string, o runOpts) (string, error) {
	cmd := exec.Command(sshBin(), append(sshArgs(t, sshOpts{}), "sudo -n bash -s")...)
	cmd.Stdin = strings.NewReader("set -euo pipefail\n" + script + "\n")
	var stdout, combined bytes.Buffer
	var outW, errW io.Writer = &stdout, &combined
	var pw, pe *prefixWriter
	if o.Stream {
		pw = &prefixWriter{mu: &outputMu, w: os.Stdout, prefix: "[" + t.Label + "] "}
		pe = &prefixWriter{mu: &outputMu, w: os.Stderr, prefix: "[" + t.Label + "] "}
		outW = io.MultiWriter(&stdout, pw)
		errW = io.MultiWriter(&combined, pe)
	}
	cmd.Stdout = io.MultiWriter(outW, &combined)
	cmd.Stderr = errW
	err := cmd.Run()
	if pw != nil {
		pw.Flush()
		pe.Flush()
	}
	if err != nil {
		what := o.What
		if what == "" {
			what = "remote command"
		}
		code := 1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			return "", fmt.Errorf("could not run %s: %w", sshBin(), err)
		}
		re := &RemoteError{Target: t, What: what, Code: code, Output: combined.String()}
		if o.Stream {
			re.Output = "" // already on screen
		}
		return stdout.String(), re
	}
	return stdout.String(), nil
}

func capture(t Target, script, what string) (string, error) {
	out, err := runScript(t, script, runOpts{What: what})
	return strings.TrimSpace(out), err
}

// pipeBetween streams one host's command output into another host's command (e.g. image export/import).
func pipeBetween(from Target, fromCmd string, to Target, toCmd string) error {
	src := exec.Command(sshBin(), append(sshArgs(from, sshOpts{}), "sudo -n sh -c "+shq(fromCmd))...)
	dst := exec.Command(sshBin(), append(sshArgs(to, sshOpts{}), "sudo -n sh -c "+shq(toCmd))...)
	var errs bytes.Buffer
	src.Stderr = &errs
	dst.Stderr = &errs
	r, w := io.Pipe()
	src.Stdout = w
	dst.Stdin = r
	if err := dst.Start(); err != nil {
		return err
	}
	if err := src.Start(); err != nil {
		_ = dst.Process.Kill()
		return err
	}
	srcErr := src.Wait()
	_ = w.CloseWithError(srcErr)
	dstErr := dst.Wait()
	if srcErr != nil || dstErr != nil {
		lines := strings.Split(strings.TrimSpace(errs.String()), "\n")
		if len(lines) > 5 {
			lines = lines[len(lines)-5:]
		}
		return fmt.Errorf("copy %s -> %s failed (%v / %v): %s", from.Label, to.Label, srcErr, dstErr, strings.Join(lines, "\n"))
	}
	return nil
}

// interactive hands the terminal to ssh (shell, tunnel, log follow) and returns its exit code.
func interactive(t Target, o sshOpts, command string) (int, error) {
	args := sshArgs(t, o)
	if command != "" {
		args = append(args, command)
	}
	cmd := exec.Command(sshBin(), args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return 1, fmt.Errorf("could not run %s: %w", sshBin(), err)
	}
	return 0, nil
}

// parseKV reads "key=value" lines.
func parseKV(out string) map[string]string {
	m := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.IndexByte(line, '='); i > 0 {
			m[line[:i]] = line[i+1:]
		}
	}
	return m
}
