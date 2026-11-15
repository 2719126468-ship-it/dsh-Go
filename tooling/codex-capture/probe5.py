import json, subprocess, copy
BASE=json.load(open('body.json'))
HDR=json.loads(open('capture.jsonl').readline())['headers']
URL='https://new.sharedchat.cc/codex/v1/responses'
def send(body,hdr,label):
    args=['curl','-s','-m','120','-o','/dev/null','-w','%{http_code}',URL]
    for k,v in hdr.items():
        if k.lower() in ('host','content-length'): continue
        args+=['-H',f'{k}: {v}']
    args+=['--data-binary',json.dumps(body)]
    print(subprocess.run(args,capture_output=True,text=True).stdout.strip(),label,flush=True)
AUTH={'authorization':HDR['authorization'],'content-type':'application/json','accept':'text/event-stream'}
send(BASE,AUTH,'body-full + only auth headers')
send(BASE,{**AUTH,'originator':'codex_exec'},'body-full + auth + originator')
send(BASE,{**AUTH,'session-id':HDR['session-id']},'body-full + auth + session-id')
cm=BASE['client_metadata']
b=copy.deepcopy(BASE); b['client_metadata']={'session_id':cm['session_id']}
send(b,{**AUTH,'session-id':'01a14999-aaaa-7bbb-8ccc-000000000000'},'session_id mismatch header')
