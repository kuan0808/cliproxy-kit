package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
)

// The panel lists the page in its sidebar and frames it; the page loads from the embedded build.
func TestThePageIsAMenuResourceServedAsHTML(t *testing.T) {
	raw, errHandle := handleMethod(pluginabi.MethodManagementRegister, nil)
	if errHandle != nil {
		t.Fatal(errHandle)
	}
	if !strings.Contains(string(raw), `"Menu":"Quota Pilot"`) {
		t.Fatalf("registration has no page menu: %s", raw)
	}

	request, _ := json.Marshal(map[string]any{"Method": http.MethodGet, "Path": "/v0/resource/plugins/quota-pilot/ui"})
	out, errHandle := handleMethod(pluginabi.MethodManagementHandle, request)
	if errHandle != nil {
		t.Fatal(errHandle)
	}
	var reply struct {
		Result struct {
			StatusCode int
			Headers    http.Header
			Body       []byte
		}
	}
	if errDecode := json.Unmarshal(out, &reply); errDecode != nil {
		t.Fatal(errDecode)
	}
	_, errBuilt := pageFiles.ReadFile("page/index.html")
	switch got := reply.Result; {
	case errBuilt != nil && got.StatusCode == http.StatusServiceUnavailable:
		// Built without the page: it says how to build it.
	case got.StatusCode != http.StatusOK || got.Headers.Get("Content-Type") != "text/html; charset=utf-8":
		t.Fatalf("page = %d %v", got.StatusCode, got.Headers)
	case got.Headers.Get("Content-Security-Policy") != "frame-ancestors 'self'" || !strings.Contains(string(got.Body), `<div id="root">`):
		t.Fatalf("page headers %v, body starts %.80s", got.Headers, got.Body)
	}
}

// The panel and the plugin store escape quotes, apostrophes, ampersands and angle brackets, and
// the panel shows the escapes as written (account&#39;s): no text either shows may hold one.
func TestPanelTextNeedsNoEscaping(t *testing.T) {
	raw, errHandle := handleMethod(pluginabi.MethodManagementRegister, nil)
	if errHandle != nil {
		t.Fatal(errHandle)
	}
	registry, errRead := os.ReadFile("../registry.json")
	if errRead != nil {
		t.Fatal(errRead)
	}
	var shown []string
	var collect func(v any)
	collect = func(v any) {
		switch v := v.(type) {
		case string:
			shown = append(shown, v)
		case []any:
			for _, item := range v {
				collect(item)
			}
		case map[string]any:
			for _, item := range v {
				collect(item)
			}
		}
	}
	for _, doc := range [][]byte{raw, registry} {
		var v any
		if errDecode := json.Unmarshal(doc, &v); errDecode != nil {
			t.Fatal(errDecode)
		}
		collect(v)
	}
	for _, text := range shown {
		if strings.ContainsAny(text, `'"&<>`) {
			t.Errorf("the panel would show this escaped: %s", text)
		}
	}
}
