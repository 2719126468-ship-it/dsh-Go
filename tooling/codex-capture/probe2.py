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
    print(subprocess.run(args,capture_output=True,text=True).stdout.strip(),label,flush=True)
cm=list(BASE['client_metadata'])
for k in cm:
    b=copy.deepcopy(BASE); b['client_metadata'].pop(k)
    send(b,f'drop client_metadata.{k}')
# minimal client_metadata
for keep in [['x-codex-turn-metadata'],['session_id'],['thread_id'],['x-codex-installation-id']]:
    b=copy.deepcopy(BASE); b['client_metadata']={k:BASE['client_metadata'][k] for k in keep if k in BASE['client_metadata']}
    send(b,f'only {keep}')
