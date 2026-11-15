import json, subprocess, copy, sys
BASE=json.load(open('body.json'))
HDR=json.loads(open('capture.jsonl').readline())['headers']
URL='https://new.sharedchat.cc/codex/v1/responses'
def send(body, hdrs=None, label=''):
    h=hdrs if hdrs is not None else HDR
    args=['curl','-s','-m','120','-o','/dev/null','-w','%{http_code}',URL]
    for k,v in h.items():
        if k.lower() in ('host','content-length'): continue
        args+=['-H',f'{k}: {v}']
    args+=['--data-binary',json.dumps(body)]
    code=subprocess.run(args,capture_output=True,text=True).stdout.strip()
    print(f'{code}  {label}', flush=True)
    return code
# baseline
send(BASE, label='baseline full body')
for drop in ['client_metadata','prompt_cache_key','text','include','reasoning','parallel_tool_calls','store','tool_choice']:
    b=copy.deepcopy(BASE); b.pop(drop,None)
    send(b, label=f'drop {drop}')
