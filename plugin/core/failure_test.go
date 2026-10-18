package core

import (
	"testing"
	"time"
)

func TestClassifyFailureTriesTheRowsInOrder(t *testing.T) {
	const s = time.Second
	cases := []struct {
		name string
		a    Attempt
		want string
	}{
		{"a client cancel after 45 s", Attempt{Status: 499, Body: `Post "http://x/v1/messages": context canceled`, Wait: 45 * s}, FailRequest},
		{"a generic 400", Attempt{Status: 400, Body: `{"error":{"message":"bad"}}`}, FailRequest},
		{"a missing thread", Attempt{Status: 404, Body: `{"type":"error","error":{"type":"not_found_error","message":"thread state for previous_message_id msg_1 not found"}}`}, FailRequest},
		{"a 400 with model_not_found", Attempt{Status: 400, Body: `{"error":{"code":"model_not_found"}}`}, FailModel},
		{"a 404 with model_not_found", Attempt{Status: 404, Body: `{"error":{"code":"model_not_found"}}`}, FailModel},
		{"a 422 model_not_found", Attempt{Status: 422, Body: `{"error":{"code":"model_not_found","message":"The model does not exist"}}`}, FailModel},
		{"a 400 unknown_model", Attempt{Status: 400, Body: `{"error":{"code":"unknown_model"}}`}, FailModel},
		{"a 404 saying model_not_supported", Attempt{Status: 404, Body: `{"error":{"message":"model_not_supported"}}`}, FailModel},
		{"a 400 not available for your plan", Attempt{Status: 400, Body: `{"error":{"message":"This model is not available for your plan"}}`}, FailModel},
		{"a 422 validation error not about the model", Attempt{Status: 422, Body: `{"error":{"type":"invalid_request_error","message":"max_tokens: must be positive"}}`}, FailRequest},
		{"a 401 after 40 s", Attempt{Status: 401, Wait: 40 * s, TTFT: 40 * s}, FailSignIn},
		{"a used-up 429 after 40 s", Attempt{Status: 429, Wait: 40 * s, TTFT: 40 * s, UsedUp: true}, FailQuota},
		{"a 504 whose ttft is 2 minutes", Attempt{Status: 504, Body: `{"error":{"message":"upstream timed out"}}`, Wait: 120 * s, TTFT: 120 * s}, FailHang},
		{"a dropped connection after 2 minutes with no ttft", Attempt{Body: `Post "http://x/v1/messages?beta=true": EOF`, Wait: 120 * s}, FailHang},
		{"a 529 after 40 s with ttft 40 s", Attempt{Status: 529, Wait: 40 * s, TTFT: 40 * s}, FailHang},
		{"a Claude stream with ttft 2 s dropped at 45 s", Attempt{Body: "unexpected EOF", Wait: 45 * s, TTFT: 2 * s}, FailConnection},
		{"a Codex stream with ttft 2 s dropped at 45 s", Attempt{Status: 408,
			Body: "stream error: stream disconnected before completion: stream closed before response.completed", Wait: 45 * s, TTFT: 2 * s}, FailConnection},
		{"a quick 501", Attempt{Status: 501, Wait: s, TTFT: s}, FailServer},
		{"a quick 507", Attempt{Status: 507, Wait: s, TTFT: s}, FailServer},
		{"a generic 404", Attempt{Status: 404, Body: `{"type":"error","error":{"type":"not_found_error","message":"not found"}}`}, FailOther},
		{"a 409", Attempt{Status: 409}, FailRequest},
		{"the 404 for a response item never stored", Attempt{Status: 404,
			Body: `{"error":{"message":"Item with id 'rs_1' not found. Items are not persisted when ` + "`store`" + ` is set to false."}}`}, FailRequest},
		{"an invalid_grant 400", Attempt{Status: 400, Body: `{"error":"invalid_grant"}`}, FailSignIn},
		{"an invalid_grant with no status and no ttft after 40 s", Attempt{Body: "token refresh failed: invalid_grant", Wait: 40 * s}, FailSignIn},
		{"a generic 404 on a compact request", Attempt{Status: 404, Body: `{"error":{"message":"not found"}}`, Compact: true}, FailRequest},
		{"a compact 401", Attempt{Status: 401, Compact: true}, FailSignIn},
		{"a compact 429 while not used up", Attempt{Status: 429, Compact: true}, FailRate},
		{"a compact 429 while used up", Attempt{Status: 429, Compact: true, UsedUp: true}, FailQuota},
		{"a compact connection error", Attempt{Body: "EOF", Compact: true}, FailRequest},
		{"a quick reset", Attempt{Body: "read tcp 1.2.3.4:5->6.7.8.9:443: read: connection reset by peer", Wait: s}, FailConnection},
		{"a quick 408", Attempt{Status: 408, Wait: s, TTFT: s}, FailTimeout},
		{"a bare deadline", Attempt{Body: "context deadline exceeded", Wait: 10 * s}, FailTimeout},
		{"a quick 524", Attempt{Status: 524, Wait: s, TTFT: s}, FailTimeout},
		{"a quick 529", Attempt{Status: 529, Wait: s, TTFT: s}, FailOverloaded},
		{"an overloaded_error body on a 500", Attempt{Status: 500, Body: `{"type":"error","error":{"type":"overloaded_error"}}`}, FailOverloaded},
		{"a quick 502", Attempt{Status: 502, Wait: s, TTFT: s}, FailServer},
		{"a 429 while not used up", Attempt{Status: 429, Wait: s, TTFT: s}, FailRate},
		{"a 418", Attempt{Status: 418, Wait: s, TTFT: s}, FailOther},
		{"a 403", Attempt{Status: 403}, FailSignIn},
	}
	for _, c := range cases {
		if got := ClassifyFailure(c.a); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}
