#!/usr/bin/env python3
"""Push the custom layer to GitHub with the contents API (no git transport)."""
import base64, json, os, subprocess, sys, time, urllib.request, urllib.error

REPO = os.environ.get('REPO', '2719126468-ship-it/dsh-Go')
BRANCH = os.environ.get('BRANCH', 'custom/pojia-free-model')
MSG = os.environ.get('MSG', 'custom layer')
TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
API = 'https://api.github.com'

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'dsh-app-custom-push',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:400]
        raise SystemExit('%s %s -> %s %s' % (method, path, e.code, body))

def base_sha(branch):
    try:
        ref = call('GET', '/repos/%s/git/ref/heads/%s' % (REPO, urllib.parse.quote(branch)))
        return ref['object']['sha']
    except SystemExit:
        return None

def main():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    # 1. blobs for every file this commit adds or changes
    files = subprocess.check_output(
        ['git', 'diff', '--name-only', '--diff-filter=AM', head + '^', head], text=True).split(chr(10))
    files = [f for f in files if f]
    print('files:', len(files))
    entries = []
    for i, f in enumerate(files):
        raw = subprocess.check_output(['git', 'show', head + ':' + f])
        blob = call('POST', '/repos/%s/git/blobs' % REPO,
                    {'content': base64.b64encode(raw).decode(), 'encoding': 'base64'})
        entries.append((f, blob['sha']))
        print('  %3d %s (%d B)' % (i + 1, f, len(raw)))
    base = base_sha(BRANCH)
    # 2. a tree over the base tree (or an empty one)
    base_tree = None
    if base:
        base_tree = call('GET', '/repos/%s/git/commits/%s' % (REPO, base))['tree']['sha']
        print('base tree', base_tree)
    tree_body = {'tree': [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': s} for p, s in entries]}
    if base_tree:
        tree_body['base_tree'] = base_tree
    tree = call('POST', '/repos/%s/git/trees' % REPO, tree_body)['sha']
    commit = call('POST', '/repos/%s/git/commits' % REPO,
                  {'message': MSG, 'tree': tree, 'parents': [base] if base else []})['sha']
    if base:
        call('PATCH', '/repos/%s/git/refs/heads/%s' % (REPO, urllib.parse.quote(BRANCH)), {'sha': commit, 'force': True})
    else:
        call('POST', '/repos/%s/git/refs' % REPO, {'ref': 'refs/heads/' + BRANCH, 'sha': commit})
    print('pushed', commit)

if __name__ == '__main__':
    import urllib.parse
    main()
