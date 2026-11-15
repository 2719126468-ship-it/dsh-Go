import http.server, json, sys, datetime
class H(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n)
        rec={'path':self.path,'headers':dict(self.headers),'body':body.decode('utf-8','replace')}
        open('capture.jsonl','a').write(json.dumps(rec,ensure_ascii=False)+'\n'); open('body.json','wb').write(body)
        # return a minimal valid SSE responses stream
        chunks=[
         ('response.created',{"type":"response.created","response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-5.6-sol","output":[]}}),
         ('response.output_item.added',{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}),
         ('response.output_text.delta',{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"OK"}),
         ('response.completed',{"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":1,"status":"completed","model":"gpt-5.6-sol","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}),
        ]
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Transfer-Encoding','chunked')
        self.end_headers()
        for ev,obj in chunks:
            data=f"event: {ev}\ndata: {json.dumps(obj)}\n\n".encode()
            self.wfile.write(hex(len(data))[2:].encode()+b'\r\n'+data+b'\r\n')
            self.wfile.flush()
        self.wfile.write(b'0\r\n\r\n'); self.wfile.flush()
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8899),H).serve_forever()
