#!/bin/zsh
# Open quota-pilot's page in the panel in the chrome-devtools-axi browser, uncached, logged in
# with the management key from the keychain ("remember password" ticked, so the page uses the
# panel's login), optionally on a view, a scope and a range by their labels:
#   panel-open.sh [view-text] [scope-text] [range-text]     e.g. panel-open.sh 用量 Codex "近 7 天"
key=$(security find-generic-password -s cliproxyapi-management -w)
chrome-devtools-axi open "http://127.0.0.1:8317/management.html?v=$(date +%s)#/" >/dev/null 2>&1; sleep 3
uid=$(chrome-devtools-axi snapshot 2>&1 | grep 'textbox "管理金鑰' | grep -o 'g[0-9]*:[0-9]*_[0-9]*')
if [ -n "$uid" ]; then
  chrome-devtools-axi fill @$uid "$key" >/dev/null 2>&1
  chrome-devtools-axi eval "(() => { const box=[...document.querySelectorAll('input[type=checkbox]')].find(x=>(x.closest('label')?.textContent||'').includes('記住密碼')); if(box && !box.checked) box.click(); return 1 })()" >/dev/null
  btn=$(chrome-devtools-axi snapshot 2>&1 | grep 'button "登入"' | grep -o 'g[0-9]*:[0-9]*_[0-9]*')
  chrome-devtools-axi click @$btn >/dev/null 2>&1; sleep 3
fi
chrome-devtools-axi eval "(() => { const a=[...document.querySelectorAll('a')].find(x=>x.textContent.trim().startsWith('quota-pilot')); if(a) a.click(); return !!a })()" >/dev/null; sleep 4
# Buttons inside the page's frame, by label.
click() { chrome-devtools-axi eval "(() => { const d=document.querySelector('iframe')?.contentDocument; const b=d && [...d.querySelectorAll('button')].find(x=>$1); if(b) b.click(); return !!b })()" >/dev/null; sleep 3; }
[ -n "$1" ] && click "x.textContent.trim()==='$1'"
[ -n "$2" ] && click "x.textContent.includes('$2')"
[ -n "$3" ] && click "x.textContent.trim()==='$3'"
# The frame's width and scroll width, and whether the page drew its title: a quick check.
chrome-devtools-axi eval "(() => { const d=document.querySelector('iframe')?.contentDocument; const r=d?.getElementById('root'); return [r?.clientWidth, r?.scrollWidth, d?.querySelector('h1')?.textContent ?? null] })()"
