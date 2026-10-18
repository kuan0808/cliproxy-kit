# A stand-in Anthropic upstream on 127.0.0.1 for the Claude Code check (run.sh): no account is ever
# reached. Main requests (those carrying CHECK-PROMPT) follow SCRIPT, one entry per request:
#   tools - two tool calls: an echo, and a background sleep that writes bg-done.txt when it ends
#   hang  - send nothing; log when the client closes the connection
#   ok    - stream a short reply at once
#   slow  - stream a short reply after 5 s
# Every request is logged, and each main request's messages are written to requests.json.
import json, select, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, SCRIPT, OUT = int(sys.argv[1]), sys.argv[2].split(','), sys.argv[3]
T0 = time.time()
lock = threading.Lock()
requests = []


def log(*a):
    print(f"[{time.time() - T0:7.2f}s]", *a, flush=True)


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def ev(self, name, data):
        self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def stream(self, n, blocks, stop):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('connection', 'close')
        self.close_connection = True
        self.end_headers()
        self.ev('message_start', {"type": "message_start", "message": {"id": f"msg_{n}", "type": "message", "role": "assistant", "model": "stub", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1}}})
        for i, (start, delta) in enumerate(blocks):
            self.ev('content_block_start', {"type": "content_block_start", "index": i, "content_block": start})
            self.ev('content_block_delta', {"type": "content_block_delta", "index": i, "delta": delta})
            self.ev('content_block_stop', {"type": "content_block_stop", "index": i})
        self.ev('message_delta', {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}})
        self.ev('message_stop', {"type": "message_stop"})

    def text(self, n):
        self.stream(n, [({"type": "text", "text": ""}, {"type": "text_delta", "text": f"hello from request {n}"})], 'end_turn')

    def do_GET(self):
        self.send_response(404)
        self.send_header('content-length', '0')
        self.end_headers()

    do_HEAD = do_GET

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length') or 0))
        try:
            j = json.loads(body)
        except ValueError:
            j = {}
        if not (b'CHECK-PROMPT' in body and 'tools' in j):
            # Claude Code's own side requests (a title, a summary) get a short answer.
            if j.get('stream'):
                return self.text(0)
            out = json.dumps({"id": "msg_side", "type": "message", "role": "assistant", "model": "stub", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        with lock:
            requests.append(j.get('messages', []))
            n = len(requests)
            with open(OUT, 'w') as f:
                json.dump(requests, f)
        what = SCRIPT[n - 1] if n <= len(SCRIPT) else 'ok'
        log(f'main #{n} -> {what}; {len(j.get("messages", []))} messages')
        if what == 'ok':
            return self.text(n)
        if what == 'slow':
            time.sleep(5)
            return self.text(n)
        if what == 'tools':
            echo = {"command": "echo check-tool-ran", "description": "check"}
            bg = {"command": "sleep 6 && echo bg-done > bg-done.txt", "description": "check background", "run_in_background": True}
            return self.stream(n, [
                ({"type": "tool_use", "id": "toolu_check1", "name": "Bash", "input": {}}, {"type": "input_json_delta", "partial_json": json.dumps(echo)}),
                ({"type": "tool_use", "id": "toolu_check2", "name": "Bash", "input": {}}, {"type": "input_json_delta", "partial_json": json.dumps(bg)}),
            ], 'tool_use')
        start = time.time()
        while time.time() - start < 120:
            r, _, _ = select.select([self.connection], [], [], 0.05)
            if r:
                try:
                    if self.connection.recv(1, socket.MSG_PEEK) == b'':
                        log(f'main #{n} closed by the client after {time.time() - start:.2f}s')
                        return
                except OSError as e:
                    log(f'main #{n} socket error after {time.time() - start:.2f}s: {e}')
                    return
        log(f'main #{n} hang ended by the stub after 120s')


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
