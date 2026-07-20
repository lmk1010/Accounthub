#!/bin/bash

WOS_SESSION='Fe26.2*1*bf0a1e27973eeaf87f52c0592237f3f962bcafb578dde093b162af4cf24b5e72*nQ1h7-WAKceKzXD0QA4ooQ*XGiS_i4bBtY6B4mPe06juGyYqypL6PviFJW-PdS18WlARyjK36BBI9eAd-yEeTw1al2BgrEIk22q35Q08YWnygnR2AvskZGXt8SIQYTV4mtGm_cJWhCkMOZRZ9NGSlx4VZhyXZE4gCLFwm3d55zo_jXeDsROBTZ5YE_oFAJTS6SrKfzp8wLZJjqWaxfgGmDRwvg1QGm97xYtmObmJElZxVEbd7nHUwF9IdFNMDfVaMm7ADJ65VbaHZ3I6WfdUT2KRo4TGgArceoEZwhP1-xBbtgmlL4NEOSvrLGRAp2Ja8w690qIPFVOTtoqLBG_QczSk4uenBD0d16LsvyrbJAxDlSQXEovnJvSRZ0wHZrLLLsBlQmaV7UOebV6xTozMbPWX1RDG7PsWdT0VlprXNPhOHK22V_oT2xnkX6nAHepbKhmquapQ501pqxtHWa4hAekADc0dx-PtPFaYdmcOqIoEicBvGuPTEpurHQojl8nN7V45BzlgeY1GuhNQSJCj5TBihXn8Me2AJWYtE4daBXJow_3AZeoHhaxkR1I19CrQn-fijtLseMCJGdFILeBFGrILq9ivP0NAmL5eVpzusZe_fzDsD8DKj8Uz4eFx7-duNyuCdP5qbozKOo2YwpdHdlQoShTmDMU1oFZy-fJequUQN89o6WpkNIH2taVPruH0zLRp5mnrj8B81cIU9lM6jyxMkbHj3T7uIPnrWC0HBAOBZAMVjLktqKJmUO1nl8ob2SIxVdvDOzAzd4eUXHdzYqecL9kzKxCTJSz-OyOKcE9q38QWJFk0JNVaoHVY1ffF-CFXWysllINjlJBOJn8OPjNzG7bxshMf0JKpMO2GjdX-1Be3vnNA3ZSyUvaL57iLhX1hOFFFl1VFlKC4ajIwhUqpe8DMBPxUPC3zXNL8x9kX2X_QIWoQkInKyMwcYLZnnelJu8_xHnldVQKSxj8Izjz7d-3NSHRmDm9dlkmwMF59jb19pFYTuGZN8xs6dQMolwD6dBoKCT9VVNJg6TfpwNHMm41P0Mo6uLYS5gPLQL5xtPfS_OJd704ItfOAPi1bGGl-Bq4yUzLeXn9A_JGIt6zDPU3MqIw0u_fTOKB9uY2JZLRdr6JPiRYsOaxmDPLuTtocvovaOmuSHC9-kaaZkLugqxtLDo4o2Nid4_jfVmD2h6kUyjBzeGdt6y68yb0GcWnaJMpTgZDL8GXBo-B9FAVjayAiT-FlMuO_nvxifMWt3E0geZPHVXc7hRkg7uoSWTRgnOPAouQcJy8LEoIsASxZwgy88TH2uaiXQvg8UzssWWxP2Cwdx8_toVJTW8sEOX02SUxJ8VbTDdjJA86wblbvYZMGCagsK6sIMdrMpQGWdejZMhzeQA5nLpEv8TkMZqeEVfYJwOaiGRnvIkR5iCJ6uq7PoDChRfCBkrqGfSkvC5tlsIplQv0LQ1YQxnCyuv3n3hn354eCqVZNwe_7rU7-HsifriGODGBuhx0PqxfuayaKUtDiqliMjZyCbevN2r31CiWeqKZm52ui_926jsBsxJWpCGKwEoW3pbJSF6qEtRZcwpkKNCjlrERy7RITPKELw8mZgMgX3ivQ9oYbj243Qn2XZRFHRgGMOcmM5bmpDl9IeTUvu0cxBmIw3qQfZa2wZhpXGwRZt4AZsuX7bVm_Z2tDuEwJYat1g-iiu6o6w**aa84f4a0bf8ff728cf916f88c1966ffa548208d55741841fd80d85584e7b27d7*di6fu56picmvIMgzCdvLCqYiMdjkQ3bQn3Cqv45IVHg~2'

# 使用抓包中的 projectId 和 chatId
PROJECT_ID='uN8EXql2g9jPFe7dUBIn6hf4'
CHAT_ID='vKwmeUqst0klqM29Xg19Ougq'

# 请求体
BODY='{"messages":[{"id":"test123","role":"user","parts":[{"type":"text","text":"你好"}]},{"id":"test456","role":"assistant","parts":[],"metadata":{"createdAt":"2026-02-02T13:40:45.930Z","updatedAt":"2026-02-02T13:40:45.931Z","model":"optimistic"}}],"agentUrl":"https://app.ami.dev","context":{"environment":{"cwd":"/Users/liumingkang/AI/CeshiAI","homeDir":"/Users/liumingkang","workingDirectory":"/Users/liumingkang/AI/CeshiAI","isGitRepo":false,"allFiles":[]}}}'

# Gzip 压缩
COMPRESSED=$(echo -n "$BODY" | gzip | base64)

echo "发送请求..."
curl -v --http2 \
  -X POST "https://app.ami.dev/api/v1/agent/v2" \
  -H "host: app.ami.dev" \
  -H "content-type: application/json" \
  -H "content-encoding: gzip" \
  -H "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ami/0.0.8 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36" \
  -H "accept: */*" \
  -H "origin: https://app.ami.dev" \
  -H "referer: https://app.ami.dev/chat/${PROJECT_ID}?chat=${CHAT_ID}" \
  -H "cookie: wos-session=${WOS_SESSION}" \
  --data-binary @<(echo -n "$BODY" | gzip) \
  2>&1
