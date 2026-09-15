#!/bin/sh
set -eu
if iptables -C INPUT -p tcp --dport 80 -m comment --comment teslalink-acme -j ACCEPT 2>/dev/null; then
    iptables -D INPUT -p tcp --dport 80 -m comment --comment teslalink-acme -j ACCEPT
fi
