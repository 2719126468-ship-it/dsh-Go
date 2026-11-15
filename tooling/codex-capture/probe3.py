import json, subprocess, copy, itertools
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
b=copy.deepcopy(BASE); b['client_metadata']={}; send(b,'empty client_metadata')
b=copy.deepcopy(BASE); b['client_metadata']={'thread_id':BASE['client_metadata']['thread_id']}; send(b,'thread_id only')
b=copy.deepcopy(BASE); b['client_metadata']={'thread_id':BASE['client_metadata']['thread_id'],'session_id':BASE['client_metadata']['session_id']}; send(b,'thread+session')
b=copy.deepcopy(BASE); b['client_metadata']={'thread_id':'01a14964-11b3-7980-bf0c-89a79df2e590','turn_id':'01a14964-17f4-76f0-8917-aef13e838e28'}; send(b,'thread+turn')
b=copy.deepcopy(BASE); b['client_metadata']={'foo':'bar'}; send(b,'foo only')
