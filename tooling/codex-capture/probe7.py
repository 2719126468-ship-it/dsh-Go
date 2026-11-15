import json, subprocess, copy, itertools
BASE=json.load(open('body.json'))
HDR=json.loads(open('capture.jsonl').readline())['headers']
URL='https://new.sharedchat.cc/codex/v1/responses'
AUTH={'authorization':HDR['authorization'],'content-type':'application/json','accept':'text/event-stream'}
def send(body,label):
    args=['curl','-s','-m','120','-o','/dev/null','-w','%{http_code}',URL]
    for k,v in AUTH.items(): args+=['-H',f'{k}: {v}']
    args+=['--data-binary',json.dumps(body)]
    print(subprocess.run(args,capture_output=True,text=True).stdout.strip(),label,flush=True)
cm=BASE['client_metadata']; ks=list(cm)
INST='x-codex-installation-id'
for k in ks:
    if k==INST: continue
    b=copy.deepcopy(BASE); b['client_metadata']={INST:cm[INST],k:cm[k]}; send(b,f'{INST}+{k}')
