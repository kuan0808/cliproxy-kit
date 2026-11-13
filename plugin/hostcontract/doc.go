// Package hostcontract holds the proxy contract run through the built plugin: quota-pilot compiled
// as the library the proxy loads, loaded by CLIProxyAPI's own plugin host in-process, in front of
// the proxy's real handlers and executors and a stub upstream. Its own test binary keeps the
// proxy's process-wide parts (the usage queue, the model registry) apart from the plugin
// package's contract tests.
package hostcontract
