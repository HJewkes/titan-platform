import { set } from "./options.js";

/** Every curl option that takes a value, as `curl --help all` lists them (curl 8.18). */
export const CURL_VALUE_OPTIONS = set(
  "--abstract-unix-socket", "--alt-svc", "--aws-sigv4", "--cacert", "--capath", "-E", "--cert", "--cert-type", "--ciphers", "-K", "--config",
  "--connect-timeout", "--connect-to", "-C", "--continue-at", "-b", "--cookie", "-c", "--cookie-jar", "--create-file-mode", "--crlfile", "--curves",
  "-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--delegation", "--dns-interface", "--dns-ipv4-addr",
  "--dns-ipv6-addr", "--dns-servers", "--doh-url", "-D", "--dump-header", "--ech", "--egd-file", "--engine", "--etag-compare", "--etag-save",
  "--expect100-timeout", "-F", "--form", "--form-string", "--ftp-account", "--ftp-alternative-to-user", "--ftp-method", "-P", "--ftp-port",
  "--ftp-ssl-ccc-mode", "--happy-eyeballs-timeout-ms", "--haproxy-clientip", "-H", "--header", "-h", "--help", "--hostpubmd5", "--hostpubsha256",
  "--hsts", "--interface", "--ip-tos", "--ipfs-gateway", "--json", "--keepalive-cnt", "--keepalive-time", "--key", "--key-type", "--knownhosts",
  "--krb", "--libcurl", "--limit-rate", "--local-port", "--login-options", "--mail-auth", "--mail-from", "--mail-rcpt", "--max-filesize",
  "--max-redirs", "-m", "--max-time", "--netrc-file", "--noproxy", "--oauth2-bearer", "-o", "--output", "--output-dir", "--parallel-max",
  "--parallel-max-host", "--pass", "--pinnedpubkey", "--preproxy", "--proto", "--proto-default", "--proto-redir", "-x", "--proxy", "--proxy-cacert",
  "--proxy-capath", "--proxy-cert", "--proxy-cert-type", "--proxy-ciphers", "--proxy-crlfile", "--proxy-header", "--proxy-key", "--proxy-key-type",
  "--proxy-pass", "--proxy-pinnedpubkey", "--proxy-service-name", "--proxy-tls13-ciphers", "--proxy-tlsauthtype", "--proxy-tlspassword",
  "--proxy-tlsuser", "-U", "--proxy-user", "--proxy1.0", "--pubkey", "-Q", "--quote", "--random-file", "-r", "--range", "--rate", "-e", "--referer",
  "-X", "--request", "--request-target", "--resolve", "--retry", "--retry-delay", "--retry-max-time", "--sasl-authzid", "--service-name", "--sigalgs",
  "--socks4", "--socks4a", "--socks5", "--socks5-gssapi-service", "--socks5-hostname", "-Y", "--speed-limit", "-y", "--speed-time", "--ssl-sessions",
  "--stderr", "-t", "--telnet-option", "--tftp-blksize", "-z", "--time-cond", "--tls-max", "--tls13-ciphers", "--tlsauthtype", "--tlspassword",
  "--tlsuser", "--trace", "--trace-ascii", "--trace-config", "--unix-socket", "-T", "--upload-file", "--upload-flags", "--url", "--url-query", "-u",
  "--user", "-A", "--user-agent", "--variable", "--vlan-priority", "-w", "--write-out",
);

/** Every curl switch, as `curl --help all` lists them (curl 8.18); each long one is also accepted as `--no-<name>`. */
export const CURL_SWITCHES = set(
  "--anyauth", "-a", "--append", "--basic", "--ca-native", "--cert-status", "--compressed", "--compressed-ssh", "--create-dirs", "--crlf", "--digest",
  "-q", "--disable", "--disable-eprt", "--disable-epsv", "--disallow-username-in-url", "--doh-cert-status", "--doh-insecure", "--dump-ca-embed", "-f",
  "--fail", "--fail-early", "--fail-with-body", "--false-start", "--follow", "--form-escape", "--ftp-create-dirs", "--ftp-pasv", "--ftp-pret",
  "--ftp-skip-pasv-ip", "--ftp-ssl-ccc", "--ftp-ssl-control", "-G", "--get", "-g", "--globoff", "--haproxy-protocol", "-I", "--head", "--http0.9",
  "-0", "--http1.0", "--http1.1", "--http2", "--http2-prior-knowledge", "--http3", "--http3-only", "--ignore-content-length", "-k", "--insecure",
  "-4", "--ipv4", "-6", "--ipv6", "-j", "--junk-session-cookies", "-l", "--list-only", "-L", "--location", "--location-trusted",
  "--mail-rcpt-allowfails", "-M", "--manual", "--metalink", "--mptcp", "--negotiate", "-n", "--netrc", "--netrc-optional", "-:", "--next",
  "--no-alpn", "-N", "--no-buffer", "--no-clobber", "--no-keepalive", "--no-npn", "--no-progress-meter", "--no-sessionid", "--ntlm", "--ntlm-wb",
  "--out-null", "-Z", "--parallel", "--parallel-immediate", "--path-as-is", "--post301", "--post302", "--post303", "-#", "--progress-bar",
  "--proxy-anyauth", "--proxy-basic", "--proxy-ca-native", "--proxy-digest", "--proxy-http2", "--proxy-insecure", "--proxy-negotiate", "--proxy-ntlm",
  "--proxy-ssl-allow-beast", "--proxy-ssl-auto-client-cert", "--proxy-tlsv1", "-p", "--proxytunnel", "--raw", "-J", "--remote-header-name", "-O",
  "--remote-name", "--remote-name-all", "-R", "--remote-time", "--remove-on-error", "--retry-all-errors", "--retry-connrefused", "--sasl-ir", "-S",
  "--show-error", "-i", "--show-headers", "-s", "--silent", "--skip-existing", "--socks5-basic", "--socks5-gssapi", "--socks5-gssapi-nec", "--ssl",
  "--ssl-allow-beast", "--ssl-auto-client-cert", "--ssl-no-revoke", "--ssl-reqd", "--ssl-revoke-best-effort", "-2", "--sslv2", "-3", "--sslv3",
  "--styled-output", "--suppress-connect-headers", "--tcp-fastopen", "--tcp-nodelay", "--tftp-no-options", "--tls-earlydata", "-1", "--tlsv1",
  "--tlsv1.0", "--tlsv1.1", "--tlsv1.2", "--tlsv1.3", "--tr-encoding", "--trace-ids", "--trace-time", "-B", "--use-ascii", "-v", "--verbose", "-V",
  "--version", "--xattr",
);
