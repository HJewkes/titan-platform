import { set } from "./options.js";

/** Every wget option that takes a value, as `wget --help` lists them (wget 1.25); `-n` takes the rest of `-nv`, `-nc` and the like. */
export const WGET_VALUE_OPTIONS = set(
  "-A", "-a", "--accept", "--accept-regex", "--append-output", "-B", "--backups", "--base", "--bind-address", "--body-data", "--body-file",
  "--ca-certificate", "--ca-directory", "--certificate", "--certificate-type", "--ciphers", "--compression", "--config", "--connect-timeout",
  "--crl-file", "--cut-dirs", "-D", "--default-page", "--directory-prefix", "--dns-timeout", "--domains", "-e", "--exclude-directories",
  "--exclude-domains", "--execute", "--follow-tags", "--ftp-password", "--ftp-user", "--header", "--http-password", "--http-user", "-I", "-i",
  "--ignore-tags", "--include-directories", "--input-file", "-l", "--level", "--limit-rate", "--load-cookies", "--local-encoding", "--method", "-n",
  "-O", "-o", "--output-document", "--output-file", "-P", "--password", "--pinnedpubkey", "--post-data", "--post-file", "--prefer-family",
  "--private-key", "--private-key-type", "--progress", "--proxy-password", "--proxy-user", "-Q", "--quota", "-R", "--read-timeout", "--referer",
  "--regex-type", "--reject", "--reject-regex", "--rejected-log", "--remote-encoding", "--report-speed", "--restrict-file-names",
  "--retry-on-http-error", "--save-cookies", "--secure-protocol", "--start-pos", "-T", "-t", "--timeout", "--tries", "-U", "--use-askpass", "--user",
  "--user-agent", "-w", "--wait", "--waitretry", "--warc-dedup", "--warc-file", "--warc-header", "--warc-max-size", "--warc-tempdir", "-X",
);

/** Every wget switch, as `wget --help` lists them (wget 1.25); each long one is also accepted as `--no-<name>`. */
export const WGET_SWITCHES = set(
  "-4", "-6", "--adjust-extension", "--ask-password", "--auth-no-challenge", "-b", "--background", "--backup-converted", "-c",
  "--content-disposition", "--content-on-error", "--continue", "--convert-file-only", "--convert-links", "-d", "--debug", "--delete-after", "-E",
  "-F", "--follow-ftp", "--force-directories", "--force-html", "--ftps-clear-data-connection", "--ftps-fallback-to-ftp", "--ftps-implicit",
  "--ftps-resume-ssl", "-H", "-h", "--help", "--hsts-file", "--https-only", "--ignore-case", "--ignore-length", "--inet4-only", "--inet6-only", "-K",
  "-k", "--keep-session-cookies", "-L", "-m", "--max-redirect", "--mirror", "-N", "--no-cache", "--no-check-certificate", "--no-clobber",
  "--no-config", "--no-cookies", "--no-directories", "--no-dns-cache", "--no-glob", "--no-host-directories", "--no-hsts", "--no-http-keep-alive",
  "--no-if-modified-since", "--no-iri", "--no-netrc", "--no-parent", "--no-passive-ftp", "--no-proxy", "--no-remove-listing",
  "--no-use-server-timestamps", "--no-verbose", "--no-warc-compression", "--no-warc-digests", "--no-warc-keep-log", "-p", "--page-requisites",
  "--preserve-permissions", "--protocol-directories", "-q", "--quiet", "-r", "--random-wait", "--recursive", "--relative", "--retr-symlinks",
  "--retry-connrefused", "--retry-on-host-error", "-S", "--save-headers", "--server-response", "--show-progress", "--span-hosts", "--spider",
  "--strict-comments", "--timestamping", "--trust-server-names", "--unlink", "-V", "-v", "--verbose", "--version", "--warc-cdx", "-x", "--xattr",
);
