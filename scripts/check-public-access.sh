#!/usr/bin/env bash
# Checks that a public hostname is protected by Cloudflare Access: an unauthenticated visitor must be sent to the
# Access sign-in (or blocked), never served the app.
#   bash scripts/check-public-access.sh https://stations.example.net
# Exit status: 0 = protected, 1 = PUBLIC (the app answered without sign-in), 2 = couldn't tell (unreachable, or an
# unexpected response such as a missing route).
# Run it right after adding the tunnel route (which is what creates the hostname's DNS record). The Access application
# must already exist by then, so the hostname is protected from its very first request; this proves it. Access answers at
# Cloudflare's edge, so a correctly created application redirects to sign-in even if the tunnel itself is down.
set -uo pipefail
BASE=${1:?usage: check-public-access.sh https://hostname}
BASE=${BASE%/}
public=0
unclear=0

for path in / /api/stations; do
  if ! out=$(curl -s -m 15 -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE$path"); then
    echo "??   $path: could not connect to $BASE (DNS record missing, or no network)"
    unclear=1
    continue
  fi
  code=${out%% *}
  location=${out#* }
  case "$code" in
    301|302|303|307|308)
      if [[ "$location" == *cloudflareaccess.com* || "$location" == *"/cdn-cgi/access/"* ]]; then
        echo "ok   $path: redirected to the Access sign-in"
      else
        echo "??   $path: redirected to $location, which is not an Access sign-in"
        unclear=1
      fi ;;
    401|403)
      echo "ok   $path: blocked ($code)" ;;
    200)
      echo "PUBLIC $path answered 200 without any sign-in" >&2
      public=1 ;;
    *)
      echo "??   $path: unexpected status $code (is the Access application created for this exact hostname?)"
      unclear=1 ;;
  esac
done

if [ "$public" = 1 ]; then
  echo "FAIL: $BASE is open to the internet. Create (or fix) the Access application before adding the tunnel route." >&2
  exit 1
fi
if [ "$unclear" = 1 ]; then
  echo "Could not confirm that $BASE is protected." >&2
  exit 2
fi
echo "PASS: $BASE asks for a sign-in."
