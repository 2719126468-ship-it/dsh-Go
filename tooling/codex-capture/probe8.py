import json, subprocess, copy
BASE=json.load(open('body.json'))
HDR=json.loads(open('capture.jsonl').readline())['headers']
URL='https://new.sharedchat.cc/codex/v1/responses'
AUTH={'authorization':HDR['authorization'],'content-type':'application/json','accept':'text/event-stream'}
def send(body,label):
    args=['curl','-s','-m','120','-o','/dev/null','-w','%{http_code}',URL]
    for k,v in AUTH.items(): args+=['-H',f'{k}: {v}']
    args+=['--data-binary',json.dumps(body)]
    print(subprocess.run(args,capture_output=True,text=True).stdout.strip(),label,flush=True)
INST=BASE['client_metadata']['x-codex-installation-id']
for val in [INST,'abc','not-a-uuid','00000000-0000-0000-0000-000000000000','']:
    b=copy.deepcopy(BASE); b['client_metadata']={'x-codex-installation-id':val}; send(b,f'inst={val[:40]!r}')
# no client_metadata at all but other fields trimmed: minimal body
b={'model':'gpt-5.6-sol','stream':True,'input':BASE['input'],'store':False,'client_metadata':{'x-codex-installation-id':INST}}
send(b,'minimal body + inst')
b2={'model':'gpt-5.6-sol','stream':False,'input':[{'type':'message','role':'user','content':[{'type':'input_text','text':'say OK'}]}],'client_metadata':{'x-codex-installation-id':INST}}
send(b2,'tiny body + inst, stream=false')
