#!/bin/sh
set -eu
iptables -C INPUT -p tcp --dport 80 -m comment --comment teslalink-acme -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -m comment --comment teslalink-acme -j ACCEPT
