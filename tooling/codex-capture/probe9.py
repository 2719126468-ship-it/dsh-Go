import json, subprocess
HDR=json.loads(open('capture.jsonl').readline())['headers']
URL='https://new.sharedchat.cc/codex/v1/responses'
AUTH={'authorization':HDR['authorization'],'content-type':'application/json','accept':'text/event-stream'}
INST=HDR['authorization']
def send(body,label,show=False):
    args=['curl','-s','-m','120','-w','\n%{http_code}',URL]
    for k,v in AUTH.items(): args+=['-H',f'{k}: {v}']
    args+=['--data-binary',json.dumps(body)]
    out=subprocess.run(args,capture_output=True,text=True).stdout
    code=out.strip().split('\n')[-1]
    print(code,label,flush=True)
    if show: print(out[:600])
    return out
cm={'x-codex-installation-id':'eaa417a7-3337-489d-bbdb-3169738a020f'}
send({'model':'gpt-5.6-sol','input':'say OK','client_metadata':cm,'stream':False},'string input, stream false',True)
send({'model':'gpt-5.6-sol','input':'say OK','client_metadata':cm,'stream':True,'instructions':'You are a roleplay partner.'},'instructions + stream true',True)
send({'model':'gpt-5.4-mini','input':[{'type':'message','role':'user','content':[{'type':'input_text','text':'hi'}]}],'client_metadata':cm,'stream':False},'gpt-5.4-mini',True)
