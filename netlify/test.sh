BASE="https://ralfw-phishingkiller.netlify.app"

echo "1) Status (Store-Diagnose)"
curl -s "$BASE/.netlify/functions/scan-status" | jq

echo "2) Background anstoßen"
curl -i -s -X POST "$BASE/.netlify/functions/scan-background"

echo "3) Kurz warten"
sleep 5

echo "4) Status erneut"
curl -s "$BASE/.netlify/functions/scan-status" | jq
