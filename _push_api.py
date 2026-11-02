import base64
import json
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
OWNER = "zhaopq123"
REPO = "ego-agent-ctl"
API = "https://api.github.com"


def token():
    return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()


def call(method, path, payload=None, tok=""):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def main():
    tok = token()
    files = []
    for dirpath, dirs, names in os.walk(ROOT):
        if ".git" in dirpath.split(os.sep):
            continue
        for n in names:
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, ROOT).replace("\\", "/")
            files.append((rel, p))
    files.sort()

    head = None
    try:
        ref = call("GET", "/repos/%s/%s/git/ref/heads/main" % (OWNER, REPO), tok=tok)
        head = ref["object"]["sha"]
    except Exception:
        head = None

    tree = []
    for rel, p in files:
        with open(p, "rb") as fh:
            blob = call("POST", "/repos/%s/%s/git/blobs" % (OWNER, REPO),
                        {"content": base64.b64encode(fh.read()).decode(), "encoding": "base64"}, tok)
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})

    tree_payload = {"tree": tree}
    if head:
        tree_payload["base_tree"] = head
    new_tree = call("POST", "/repos/%s/%s/git/trees" % (OWNER, REPO), tree_payload, tok)

    commit_payload = {
        "message": "feat: ego-agent-ctl 1.0.0 (Markdown state + id actions + readback + diagnose)",
        "tree": new_tree["sha"],
        "parents": [head] if head else []
    }
    commit = call("POST", "/repos/%s/%s/git/commits" % (OWNER, REPO), commit_payload, tok)

    if head:
        call("PATCH", "/repos/%s/%s/git/refs/heads/main" % (OWNER, REPO),
             {"sha": commit["sha"], "force": True}, tok)
    else:
        call("POST", "/repos/%s/%s/git/refs" % (OWNER, REPO),
             {"ref": "refs/heads/main", "sha": commit["sha"]}, tok)

    print("COMMIT=" + commit["sha"])
    print("FILES=" + str(len(files)))


if __name__ == "__main__":
    main()
