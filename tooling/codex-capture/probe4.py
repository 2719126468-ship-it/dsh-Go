import json, subprocess, copy
BASE=json.load(open('body.json'))
HDR=json.loads(open('capture.jsonl').readline())['headers']
URL='https://new.sharedchat.cc/codex/v1/responses'
def send(body,label):
    args=['curl','-s','-m','120','-o','/dev/null','-w','%{http_code}',URL]
    for k,v in HDR.items():
        if k.lower() in ('host','content-length'): continue
        args+=['-H',f'{k}: {v}']
    args+=['--data-binary',json.dumps(body)]
    print(subprocess.run(args,capture_output=True,text=True).stdout.strip(),label,f'len={len(json.dumps(body))}',flush=True)
cm=BASE['client_metadata']
keys=list(cm)
for n in (2,3,4):
    b=copy.deepcopy(BASE); b['client_metadata']={k:cm[k] for k in keys[:n]}; send(b,f'first {n} keys')
b=copy.deepcopy(BASE); b['client_metadata']={'foo':'x'*400}; send(b,'foo padded 400')
b=copy.deepcopy(BASE); b['client_metadata']={'session_id':cm['session_id'],'foo':'bar'}; send(b,'session+foo')
b=copy.deepcopy(BASE); b['client_metadata']={'session_id':'00000000-0000-0000-0000-000000000000'}; send(b,'session fake uuid')
b=copy.deepcopy(BASE); b['client_metadata']={'session_id':'abc'}; send(b,'session non-uuid')
