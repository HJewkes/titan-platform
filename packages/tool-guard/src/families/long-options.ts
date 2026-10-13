/** Stands for a long option that abbreviates several real ones; curl and wget refuse it, so a reader treats it as hidden. */
export const AMBIGUOUS_LONG = "--(ambiguous)";

export type LongResolver = (flag: string) => string;

interface LongTable {
  /** Every long name the tool accepts, without the leading `--`. */
  names: readonly string[];
  /** The `--name` spellings that take a value. */
  values: ReadonlySet<string>;
}

/**
 * Every long option curl 8.18.0 accepts, hidden aliases and `--no-` forms included: each word in the binary was run as
 * `curl --word`, and `=` marks one curl answered with "requires parameter". `--help all` omits names such as
 * `--http1.0`, `--krb4` and `--keepalive`.
 */
export const CURL_LONG = table(`
  abstract-unix-socket= alpn alt-svc= anyauth append aws-sigv4= basic buffer ca-native cacert= capath= cert-status cert-type= cert= ciphers=
  clobber compressed compressed-ssh config= connect-timeout= connect-to= continue-at= cookie-jar= cookie= create-dirs create-file-mode= crlf
  crlfile= curves= data-ascii= data-binary= data-raw= data-urlencode= data= delegation= digest disable disable-eprt disable-epsv
  disallow-username-in-url dns-interface= dns-ipv4-addr= dns-ipv6-addr= dns-servers= doh-cert-status doh-insecure doh-url= dump-ca-embed
  dump-header= ech= egd-file= engine= eprt epsv etag-compare= etag-save= expect100-timeout= fail fail-early fail-with-body false-start follow
  form-escape form-string= form= ftp-account= ftp-alternative-to-user= ftp-create-dirs ftp-method= ftp-pasv ftp-port= ftp-pret
  ftp-skip-pasv-ip ftp-ssl ftp-ssl-ccc ftp-ssl-ccc-mode= ftp-ssl-control ftp-ssl-reqd get globoff happy-eyeballs-timeout-ms=
  haproxy-clientip= haproxy-protocol head header= help hostpubmd5= hostpubsha256= hsts= http0.9 http1.0 http1.1 http2 http2-prior-knowledge
  http3 http3-only ignore-content-length include insecure interface= ip-tos= ipfs-gateway= ipv4 ipv6 json= junk-session-cookies keepalive
  keepalive-cnt= keepalive-time= key-type= key= knownhosts= krb4= krb= libcurl= limit-rate= list-only local-port= location location-trusted
  login-options= mail-auth= mail-from= mail-rcpt-allowfails mail-rcpt= manual max-filesize= max-redirs= max-time= metalink mptcp negotiate
  netrc netrc-file= netrc-optional next no-alpn no-append no-basic no-buffer no-ca-native no-cert-status no-clobber no-compressed
  no-compressed-ssh no-create-dirs no-crlf no-digest no-disable no-disable-eprt no-disable-epsv no-disallow-username-in-url
  no-doh-cert-status no-doh-insecure no-eprt no-epsv no-fail no-fail-early no-fail-with-body no-false-start no-follow no-form-escape
  no-ftp-create-dirs no-ftp-pret no-ftp-skip-pasv-ip no-ftp-ssl no-ftp-ssl-ccc no-ftp-ssl-control no-ftp-ssl-reqd no-get no-globoff
  no-haproxy-protocol no-head no-http0.9 no-ignore-content-length no-include no-insecure no-junk-session-cookies no-keepalive no-list-only
  no-location no-location-trusted no-mail-rcpt-allowfails no-manual no-metalink no-mptcp no-negotiate no-netrc no-netrc-optional no-npn
  no-ntlm no-ntlm-wb no-out-null no-parallel no-parallel-immediate no-path-as-is no-post301 no-post302 no-post303 no-progress-bar
  no-progress-meter no-proxy-anyauth no-proxy-basic no-proxy-ca-native no-proxy-digest no-proxy-http2 no-proxy-insecure no-proxy-negotiate
  no-proxy-ntlm no-proxy-ssl-allow-beast no-proxy-ssl-auto-client-cert no-proxytunnel no-raw no-remote-header-name no-remote-name
  no-remote-name-all no-remote-time no-remove-on-error no-retry-all-errors no-retry-connrefused no-sasl-ir no-sessionid no-show-error
  no-show-headers no-silent no-skip-existing no-socks5-basic no-socks5-gssapi no-socks5-gssapi-nec no-ssl no-ssl-allow-beast
  no-ssl-auto-client-cert no-ssl-no-revoke no-ssl-reqd no-ssl-revoke-best-effort no-styled-output no-suppress-connect-headers no-tcp-fastopen
  no-tcp-nodelay no-tftp-no-options no-tls-earlydata no-tr-encoding no-trace-ids no-trace-time no-use-ascii no-verbose no-version no-xattr
  noproxy= npn ntlm ntlm-wb oauth2-bearer= out-null output-dir= output= parallel parallel-immediate parallel-max-host= parallel-max= pass=
  path-as-is pinnedpubkey= post301 post302 post303 preproxy= progress-bar progress-meter proto-default= proto-redir= proto= proxy-anyauth
  proxy-basic proxy-ca-native proxy-cacert= proxy-capath= proxy-cert-type= proxy-cert= proxy-ciphers= proxy-crlfile= proxy-digest
  proxy-header= proxy-http2 proxy-insecure proxy-key-type= proxy-key= proxy-negotiate proxy-ntlm proxy-pass= proxy-pinnedpubkey=
  proxy-service-name= proxy-ssl-allow-beast proxy-ssl-auto-client-cert proxy-tls13-ciphers= proxy-tlsauthtype= proxy-tlspassword=
  proxy-tlsuser= proxy-tlsv1 proxy-user= proxy1.0= proxy= proxytunnel pubkey= quote= random-file= range= rate= raw referer=
  remote-header-name remote-name remote-name-all remote-time remove-on-error request-target= request= resolve= retry-all-errors
  retry-connrefused retry-delay= retry-max-time= retry= sasl-authzid= sasl-ir service-name= sessionid show-error show-headers sigalgs= silent
  skip-existing socks4= socks4a= socks5-basic socks5-gssapi socks5-gssapi-nec socks5-gssapi-service= socks5-hostname= socks5= speed-limit=
  speed-time= ssl ssl-allow-beast ssl-auto-client-cert ssl-no-revoke ssl-reqd ssl-revoke-best-effort ssl-sessions= sslv2 sslv3 stderr=
  styled-output suppress-connect-headers tcp-fastopen tcp-nodelay telnet-option= tftp-blksize= tftp-no-options time-cond= tls-earlydata
  tls-max= tls13-ciphers= tlsauthtype= tlspassword= tlsuser= tlsv1 tlsv1.0 tlsv1.1 tlsv1.2 tlsv1.3 tr-encoding trace-ascii= trace-config=
  trace-ids trace-time trace= unix-socket= upload-file= upload-flags= url-query= url= use-ascii user-agent= user= variable= verbose version
  vlan-priority= write-out= xattr`);

/**
 * Every long option GNU Wget 1.25.0 accepts, as getopt_long lists them when `wget --<letter>` is ambiguous; `=` marks
 * one wget answered with "requires an argument". `--help` omits names such as `--hsts`, whose omission would let
 * `--hsts` resolve to `--hsts-file` and swallow the next word.
 */
export const WGET_LONG = table(`
  accept-regex= accept= adjust-extension append-output= ask-password auth-no-challenge background backup-converted backups base=
  bind-address= body-data= body-file= ca-certificate= ca-directory= cache certificate-type= certificate= check-certificate ciphers= clobber
  compression= config= connect-timeout= content-disposition content-on-error continue convert-file-only convert-links cookies crl-file=
  cut-dirs= debug default-page= delete-after directories directory-prefix= dns-cache dns-timeout= domains= dont-remove-listing dot-style=
  egd-file= exclude-directories= exclude-domains= execute= follow-ftp follow-tags= force-directories force-html ftp-password= ftp-user=
  ftps-clear-data-connection ftps-fallback-to-ftp ftps-implicit ftps-resume-ssl glob header= help host-directories hsts hsts-file=
  html-extension htmlify http-keep-alive http-passwd= http-password= http-user= https-only if-modified-since ignore-case ignore-length
  ignore-tags= include-directories= inet4-only inet6-only input-file= iri keep-badhash keep-session-cookies level= limit-rate= load-cookies=
  local-encoding= max-redirect= method= mirror netrc no-adjust-extension no-ask-password no-auth-no-challenge no-background
  no-backup-converted no-backups no-cache no-check-certificate no-clobber no-config no-content-disposition no-content-on-error no-continue
  no-convert-file-only no-convert-links no-cookies no-debug no-delete-after no-directories no-dns-cache no-follow-ftp no-force-directories
  no-force-html no-ftps-clear-data-connection no-ftps-fallback-to-ftp no-ftps-implicit no-ftps-resume-ssl no-glob no-host-directories no-hsts
  no-html-extension no-htmlify no-http-keep-alive no-https-only no-if-modified-since no-ignore-case no-ignore-length no-inet4-only
  no-inet6-only no-iri no-keep-badhash no-keep-session-cookies no-mirror no-netrc no-no-clobber no-no-config no-no-parent no-page-requisites
  no-parent no-passive-ftp no-preserve-permissions no-protocol-directories no-proxy no-quiet no-random-wait no-recursive no-relative
  no-remove-listing no-report-speed no-restrict-file-names no-retr-symlinks no-retry-connrefused no-retry-on-host-error no-save-headers
  no-server-response no-show-progress no-span-hosts no-spider no-strict-comments no-timestamping no-trust-server-names no-unlink
  no-use-server-timestamps no-verbose no-warc-cdx no-warc-compression no-warc-digests no-warc-keep-log no-xattr no= output-document=
  output-file= page-requisites parent passive-ftp password= pinnedpubkey= post-data= post-file= prefer-family= preserve-permissions
  private-key-type= private-key= progress= protocol-directories proxy proxy-passwd= proxy-password= proxy-user= proxy__compat= quiet quota=
  random-file= random-wait read-timeout= recursive referer= regex-type= reject-regex= reject= rejected-log= relative remote-encoding=
  remove-listing report-speed restrict-file-names retr-symlinks retry-connrefused retry-on-host-error retry-on-http-error= save-cookies=
  save-headers secure-protocol= server-response show-progress span-hosts spider start-pos= strict-comments timeout= timestamping tries=
  trust-server-names unlink use-askpass= use-server-timestamps user-agent= user= verbose version wait= waitretry= warc-cdx warc-compression
  warc-dedup= warc-digests warc-file= warc-header= warc-keep-log warc-max-size= warc-tempdir= xattr`);

/**
 * Maps a `--flag` to the table entry it names: an exact match wins, then a unique prefix, as getopt_long and older
 * curl both read one. Several prefix matches give AMBIGUOUS_LONG; none leaves the flag as given.
 */
export function resolveLong({ names }: LongTable, caseless: boolean): LongResolver {
  const fold = (s: string): string => (caseless ? s.toLowerCase() : s);
  const folded = names.map(fold);
  return (flag) => {
    const name = fold(flag.slice(2));
    if (!flag.startsWith("--") || name === "") return flag;
    const exact = folded.indexOf(name);
    if (exact >= 0) return `--${names[exact]}`;
    const hits = names.filter((_, i) => folded[i]?.startsWith(name));
    if (hits.length > 1) return AMBIGUOUS_LONG;
    return hits[0] === undefined ? flag : `--${hits[0]}`;
  };
}

function table(text: string): LongTable {
  const words = text.trim().split(/\s+/);
  return {
    names: words.map((w) => w.replace(/=$/, "")),
    values: new Set(words.filter((w) => w.endsWith("=")).map((w) => `--${w.slice(0, -1)}`)),
  };
}
