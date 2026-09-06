#!/bin/sh
# Shared entry point. Deployment-definition checks belong to the selected build's installer.
set -eu
umask 077

channel=beta
requested_version=
install_directory=/var/lib/appsweet
release_stage=
temporary_directory=
host_package_dir=
channel_base=https://releases.appsweet.app/releases
release_base=https://github.com/Blendable-dev/appsweet-releases/releases/download
trusted_key_id=sha256:1552d0983f559e84edc86c113f1e472ba90ed11a77004531387aa1b39ed69a61
cosign_image=gcr.io/projectsigstore/cosign:v3.0.6@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00

fail() { printf 'release_verification_failed: %s\n' "$1" >&2; exit 1; }
cleanup() {
  [ -z "$temporary_directory" ] || rm -rf "$temporary_directory"
  [ -z "$host_package_dir" ] || rm -rf "$host_package_dir"
  [ -z "$release_stage" ] || rm -rf "$release_stage"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Parse a function-local copy, retaining every original argument without eval or word splitting.
select_channel() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --channel)
        [ "$#" -ge 2 ] || fail '--channel requires alpha or beta'
        channel=$2; shift 2 ;;
      --version)
        [ "$#" -ge 2 ] || fail '--version requires a build version'
        requested_version=$2; shift 2 ;;
      --renew-claim) shift ;;
      --install-dir)
        [ "$#" -ge 2 ] || fail '--install-dir requires an absolute private directory'
        install_directory=$2; shift 2 ;;
      --public-ipv4|--console-hostname|--deployment-slug|--dokploy-api-origin|--dokploy-compose-id|--dokploy-key-file|--platform-network)
        [ "$#" -ge 2 ] || fail 'bootstrap option requires a value'
        shift 2 ;;
      --help|-h)
        printf '%s\n' 'usage: install.sh [--channel alpha|beta] [--public-ipv4 <address>] [--console-hostname <hostname>]' \
          '                  [--install-dir <absolute-private-directory>] [--deployment-slug <name>] [--renew-claim]' \
          'Dokploy: add --dokploy-api-origin <https-origin> --dokploy-compose-id <id>' \
          '         --dokploy-key-file <private-absolute-file> --platform-network <network> --console-hostname <hostname>'
        exit 0 ;;
      *) fail "unsupported installer option: $1" ;;
    esac
  done
}
select_channel "$@"
case "$channel" in alpha|beta) ;; *) fail 'channel must be alpha or beta' ;; esac

# HOST_PREPARATION_BEGIN — kept in the shared script so a fresh host needs no unsigned child.
host_fail() { printf 'host_preparation_failed: %s\n' "$1" >&2; exit 1; }
os_value() {
  # os-release is data, not executable shell. Refuse duplicate/malformed supported fields.
  awk -F= -v name="$1" '
    $1 == name { count++; value=substr($0, length(name)+2);
      if (value ~ /^"[a-z0-9.]+"$/) value=substr(value,2,length(value)-2);
      if (value !~ /^[a-z0-9.]+$/) invalid=1 }
    END { if (count != 1 || invalid) exit 1; print value }
  ' /etc/os-release
}
tool_at_least() {
  awk -v value="$1" -v floor="$2" 'BEGIN {
    sub(/^v/, "", value);
    if (value !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 1;
    split(value,v,"."); split(floor,f,".");
    for (i=1;i<=3;i++) { if (v[i]+0>f[i]+0) exit 0; if (v[i]+0<f[i]+0) exit 1 }
    exit 0
  }'
}
host_docker() {
  env -i PATH="$PATH" docker --host unix:///var/run/docker.sock "$@"
}
inspect_runtime() {
  host_version=$(host_docker version --format '{{.Server.Version}}') ||
    host_fail 'Docker is installed but its local daemon is unavailable; start it and rerun'
  tool_at_least "$host_version" 24.0.0 || host_fail 'Docker Engine 24.0.0 or newer is required'
  host_api_min=$(host_docker version --format '{{.Server.MinAPIVersion}}') ||
    host_fail 'Docker API support could not be inspected'
  host_api_max=$(host_docker version --format '{{.Server.APIVersion}}') ||
    host_fail 'Docker API support could not be inspected'
  # Some Engine 29 versions raised their API floor. Check actual daemon support, not only version.
  awk -v low="$host_api_min" -v high="$host_api_max" 'BEGIN {
    if (low !~ /^1\.[0-9]+$/ || high !~ /^1\.[0-9]+$/) exit 1;
    split(low,l,"."); split(high,h,"."); exit !(l[2]<=43 && h[2]>=43)
  }' || host_fail 'this Docker daemon does not support the release executor API 1.43'
  host_needs_compose=no
  if host_compose=$(host_docker compose version --short 2>/dev/null); then
    tool_at_least "$host_compose" 2.23.1 || host_fail 'Docker Compose 2.23.1 or newer is required'
  else
    host_needs_compose=yes
  fi
}
package_record_directory() {
  [ ! -L /var/lib/appsweet-bootstrap ] || host_fail 'package resume directory must not be a symlink'
  mkdir -p /var/lib/appsweet-bootstrap
  [ "$(stat -c '%a:%u' /var/lib/appsweet-bootstrap)" = 700:0 ] ||
    host_fail 'package resume directory must be private and root-owned'
}
prepare_local_host() {
  [ "$(uname -s)" = Linux ] || host_fail 'fresh installation supports Linux; use --config for advanced rendering'
  [ "$(id -u)" = 0 ] || host_fail 'run the fresh-server installation with sudo or as root'
  [ -z "${DOCKER_HOST:-}" ] && [ -z "${DOCKER_CONTEXT:-}" ] ||
    host_fail 'fresh installation uses the local daemon; unset Docker host/context overrides'
  host_os=$(os_value ID) || host_fail 'cannot read supported operating system identity'
  host_os_version=$(os_value VERSION_ID) || host_fail 'cannot read supported operating system version'
  case "$host_os:$host_os_version" in
    ubuntu:24.04) host_suite=noble ;;
    debian:12) host_suite=bookworm ;;
    *) host_fail 'supported fresh hosts are Ubuntu 24.04 and Debian 12' ;;
  esac
  case "$(uname -m)" in
    x86_64) host_arch=amd64 ;;
    aarch64|arm64) host_arch=arm64 ;;
    *) host_fail 'supported host architectures are amd64 and arm64' ;;
  esac
  host_pending_kind=
  if [ -e /var/lib/appsweet-bootstrap/packages.pending ] || [ -L /var/lib/appsweet-bootstrap/packages.pending ]; then
    package_record_directory
    [ ! -L /var/lib/appsweet-bootstrap/packages.pending ] && [ -f /var/lib/appsweet-bootstrap/packages.pending ] &&
      [ "$(stat -c '%a:%u' /var/lib/appsweet-bootstrap/packages.pending)" = 600:0 ] ||
      host_fail 'package resume record must be a private root-owned file'
    case "$(cat /var/lib/appsweet-bootstrap/packages.pending)" in
      "1:engine:$host_os:$host_arch") host_pending_kind=engine ;;
      "1:compose:$host_os:$host_arch") host_pending_kind=compose ;;
      *) host_fail 'package resume record does not match this supported host' ;;
    esac
  fi
  host_has_docker=no
  host_needs_compose=yes
  if command -v docker >/dev/null 2>&1 && [ "$host_pending_kind" != engine ]; then
    inspect_runtime
    host_has_docker=yes
  else
    [ "$host_pending_kind" != compose ] || host_fail 'the existing Docker installation disappeared during Compose installation'
    for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
      installed=$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)
      [ "$installed" != 'install ok installed' ] ||
        host_fail 'a conflicting container runtime package exists; resolve it before installing Docker'
    done
  fi
  host_need_packages=no
  for utility in curl jq; do
    command -v "$utility" >/dev/null 2>&1 || host_need_packages=yes
  done
  [ -s /etc/ssl/certs/ca-certificates.crt ] || host_need_packages=yes
  [ "$host_has_docker" = yes ] && [ "$host_needs_compose" = no ] || host_need_packages=yes
  if [ "$host_has_docker" = no ] || [ "$host_needs_compose" = yes ]; then
    package_record_directory
    host_record_kind=compose
    [ "$host_has_docker" = yes ] || host_record_kind=engine
    host_record_tmp=$(mktemp /var/lib/appsweet-bootstrap/.packages.XXXXXX)
    printf '1:%s:%s:%s\n' "$host_record_kind" "$host_os" "$host_arch" >"$host_record_tmp"
    chmod 600 "$host_record_tmp"
    mv "$host_record_tmp" /var/lib/appsweet-bootstrap/packages.pending
    sync /var/lib/appsweet-bootstrap/packages.pending
    sync /var/lib/appsweet-bootstrap
  fi
  if [ "$host_need_packages" = yes ]; then
    command -v apt-get >/dev/null 2>&1 || host_fail 'supported apt package manager is unavailable'
    env DEBIAN_FRONTEND=noninteractive apt-get update || host_fail 'package index refresh failed; rerun to resume'
    env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove --no-upgrade --no-install-recommends ca-certificates curl jq gnupg ||
      host_fail 'prerequisite package installation failed; rerun to resume'
  fi
  if [ "$host_has_docker" = no ] || [ "$host_needs_compose" = yes ]; then
    host_package_dir=$(mktemp -d /tmp/appsweet-packages.XXXXXX) || host_fail 'cannot prepare private package verification'
    chmod 700 "$host_package_dir"
    env -i PATH="$PATH" curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 15 --max-time 60 --output "$host_package_dir/docker.asc" \
      "https://download.docker.com/linux/$host_os/gpg" || host_fail 'Docker repository key download failed'
    mkdir "$host_package_dir/gnupg"
    chmod 700 "$host_package_dir/gnupg"
    host_key_fingerprint=$(gpg --batch --homedir "$host_package_dir/gnupg" --with-colons \
      --show-keys "$host_package_dir/docker.asc" 2>/dev/null | awk -F: '
        $1=="pub" { count++ }
        $1=="fpr" && fingerprint=="" { fingerprint=$10 }
        END { if (count!=1) exit 1; print fingerprint }') || host_fail 'Docker signing key is malformed'
    [ "$host_key_fingerprint" = 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ] ||
      host_fail 'Docker repository signing key does not match the trusted fingerprint'
    cat >"$host_package_dir/docker.sources" <<REPOSITORY
Types: deb
URIs: https://download.docker.com/linux/$host_os
Suites: $host_suite
Components: stable
Architectures: $host_arch
Signed-By: /etc/apt/keyrings/appsweet-docker.asc
REPOSITORY
    for directory in /etc/apt/keyrings /etc/apt/sources.list.d; do
      [ ! -L "$directory" ] || host_fail 'bootstrap package directories must not be symlinks'
    done
    mkdir -p /etc/apt/keyrings /etc/apt/sources.list.d
    for file in /etc/apt/keyrings/appsweet-docker.asc /etc/apt/sources.list.d/appsweet-docker.sources; do
      [ ! -L "$file" ] || host_fail 'bootstrap package configuration must not be a symlink'
    done
    # These files are bootstrap-owned. An existing different source is never silently overwritten.
    if [ -e /etc/apt/sources.list.d/appsweet-docker.sources ]; then
      cmp -s /etc/apt/sources.list.d/appsweet-docker.sources "$host_package_dir/docker.sources" ||
        host_fail 'existing AppSweet package source differs from this supported host'
    fi
    if [ -e /etc/apt/keyrings/appsweet-docker.asc ]; then
      cmp -s /etc/apt/keyrings/appsweet-docker.asc "$host_package_dir/docker.asc" ||
        host_fail 'existing AppSweet package key differs from the trusted key'
    fi
    install -m 644 "$host_package_dir/docker.asc" /etc/apt/keyrings/appsweet-docker.asc
    install -m 644 "$host_package_dir/docker.sources" /etc/apt/sources.list.d/appsweet-docker.sources
    rm -rf "$host_package_dir"
    host_package_dir=
    env DEBIAN_FRONTEND=noninteractive apt-get update || host_fail 'Docker package index refresh failed; rerun to resume'
    if [ "$host_has_docker" = no ]; then
      env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove --no-upgrade --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin ||
        host_fail 'Docker installation failed; rerun to resume'
      systemctl enable --now docker || host_fail 'Docker could not start; inspect the service and rerun'
    else
      env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove --no-upgrade --no-install-recommends \
        docker-compose-plugin || host_fail 'Compose plugin installation failed; rerun to resume'
    fi
    inspect_runtime
    [ "$host_needs_compose" = no ] || host_fail 'Docker Compose plugin remains unavailable after installation'
  fi
  # A failed package command leaves the private marker. A verified runtime closes preparation.
  if [ -e /var/lib/appsweet-bootstrap/packages.pending ]; then
    rm /var/lib/appsweet-bootstrap/packages.pending
    sync /var/lib/appsweet-bootstrap
  fi
}
# HOST_PREPARATION_END
prepare_local_host

for command in curl docker jq mktemp sh flock; do
  command -v "$command" >/dev/null 2>&1 || fail "required prerequisite is missing: $command"
done

# Root-owned installation state is also the selection lock. Resolve no symlink components and
# never repair permissions on an existing directory. A retry is not a channel update.
case "$install_directory" in /*) ;; *) fail 'installation directory must be absolute' ;; esac
case "$install_directory" in *[!a-zA-Z0-9_/-]*|*/../*|*/./*|*/|/) fail 'invalid installation directory' ;; esac
private_mode() { stat -c '%a:%u' "$1" 2>/dev/null || stat -f '%Lp:%u' "$1"; }
private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(private_mode "$1")" = "600:$(id -u)" ] ||
    fail 'retained selection must be a private owned regular file'
}
ancestor=$install_directory
while [ "$ancestor" != / ]; do
  [ ! -L "$ancestor" ] || fail 'installation path must not contain a symlink'
  ancestor=$(dirname "$ancestor")
done
if [ ! -e "$install_directory" ]; then
  mkdir "$install_directory" || fail 'installation parent must exist'
fi
[ -d "$install_directory" ] && [ "$(private_mode "$install_directory")" = "700:$(id -u)" ] ||
  fail 'installation directory must be private and owned by the installer'
if [ -e "$install_directory/install.lock" ] || [ -L "$install_directory/install.lock" ]; then
  private_file "$install_directory/install.lock"
fi
exec 9>"$install_directory/install.lock"
flock -n 9 || fail 'another installer is running for this directory'
resume=no
if [ -e "$install_directory/release" ] || [ -L "$install_directory/release" ]; then
  [ -d "$install_directory/release" ] && [ ! -L "$install_directory/release" ] &&
    [ "$(private_mode "$install_directory/release")" = "700:$(id -u)" ] || fail 'unsafe retained release'
  for retained in channel.json channel.json.sigstore.json release.json release.json.sigstore.json installer.sh installer.sh.sigstore.json; do
    private_file "$install_directory/release/$retained"
  done
  [ "$(find "$install_directory/release" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 6 ] || fail 'unknown retained release files'
  resume=yes
else
  for entry in "$install_directory"/* "$install_directory"/.[!.]* "$install_directory"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in
      install.lock) ;;
      .release.*)
        # An interrupted unpublished copy has no installation authority. Preserve it without
        # adopting any of its files; the next verified selection is published independently.
        [ -d "$entry" ] && [ ! -L "$entry" ] && [ "$(private_mode "$entry")" = "700:$(id -u)" ] ||
          fail 'unsafe interrupted release stage' ;;
      *) fail 'unknown installation state; use a new empty directory' ;;
    esac
  done
fi

umask 077
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/appsweet-bootstrap.XXXXXX")
mkdir "$temporary_directory/docker"
cat >"$temporary_directory/key.pub" <<'PUBLIC_KEY'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfTHiiv+tIhcwnVCJQ6/9WVfOF3jP
J9DQZoquPKXK7QBTB6NvWuX+hSYyNjLTEO9uHc80itxuR+ay066hEsufdA==
-----END PUBLIC KEY-----
PUBLIC_KEY

download() {
  # No curlrc, authorization environment, registry credentials or response bodies in diagnostics.
  env -i PATH="$PATH" curl -q --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 3 \
    --output "$temporary_directory/$2" "$1" || fail 'public release download failed'
}
verify() {
  env -i PATH="$PATH" docker --config "$temporary_directory/docker" run \
    --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$temporary_directory,dst=/verify,readonly" \
    "$cosign_image" verify-blob --key /verify/key.pub --insecure-ignore-tlog \
    --bundle "/verify/$1.sigstore.json" "/verify/$1" >/dev/null 2>&1 || fail 'signature verification failed'
}
hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
check_hash() { [ "$(hash "$temporary_directory/$1")" = "$2" ] || fail 'signed artifact digest mismatch'; }

download "$channel_base/$channel.json" channel.json
download "$channel_base/$channel.json.sigstore.json" channel.json.sigstore.json
verify channel.json
jq -e --arg channel "$channel" --arg key "$trusted_key_id" --arg base "$release_base" \
  --arg revocations "$channel_base/revoked-key-ids.txt" '
  (.channel == $channel) and (.signingKeyId == $key) and
  (.schemaVersion == 2 and .releaseReadiness == "self-host-candidate" and
    (.version | test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-build\\.[1-9][0-9]*$"))) and
  (.tag == ("backend-v" + .version)) and
  (has("rollingImage") | not) and
  (.releaseManifest.url == ($base + "/" + .tag + "/release.json")) and
  (.revocations.url == $revocations) and
  ([.releaseManifest.sha256, .revocations.sha256, .deploymentDefinitionSha256] |
    all(.[]; type == "string" and test("^[a-f0-9]{64}$")))
' "$temporary_directory/channel.json" >/dev/null || fail 'invalid channel binding'

download "$channel_base/revoked-key-ids.txt" revoked-key-ids.txt
check_hash revoked-key-ids.txt "$(jq -er .revocations.sha256 "$temporary_directory/channel.json")"
awk -v key="$trusted_key_id" '
  { sub(/[[:space:]]*#.*/, ""); if ($0 ~ /^[[:space:]]*$/) next;
    if ($0 !~ /^sha256:[a-f0-9]+$/ || length($0) != 71 || $0 == key) exit 1 }
' "$temporary_directory/revoked-key-ids.txt" || fail 'invalid revocations or revoked release key'
cp "$temporary_directory/channel.json" "$temporary_directory/current-channel.json"
cp "$temporary_directory/channel.json.sigstore.json" "$temporary_directory/current-channel.json.sigstore.json"
if [ "$resume" = yes ]; then
  cp "$install_directory/release/channel.json" "$temporary_directory/channel.json"
  cp "$install_directory/release/channel.json.sigstore.json" "$temporary_directory/channel.json.sigstore.json"
  verify channel.json
  jq -e --arg channel "$channel" --arg key "$trusted_key_id" --arg base "$release_base" '
    .schemaVersion == 2 and .channel == $channel and .signingKeyId == $key and
    .releaseReadiness == "self-host-candidate" and
    (.version | test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-build\\.[1-9][0-9]*$")) and
    .tag == ("backend-v" + .version) and
    .releaseManifest.url == ($base + "/" + .tag + "/release.json") and
    ([.releaseManifest.sha256, .deploymentDefinitionSha256] | all(.[]; type == "string" and test("^[a-f0-9]{64}$")))
  ' "$temporary_directory/channel.json" >/dev/null || fail 'retained selection does not match the requested channel'
fi
version=$(jq -er .version "$temporary_directory/channel.json")
[ -z "$requested_version" ] || [ "$requested_version" = "$version" ] || fail 'requested version is not the selected installation build'
manifest_url=$(jq -er .releaseManifest.url "$temporary_directory/channel.json")
download "$manifest_url" release.json
download "$manifest_url.sigstore.json" release.json.sigstore.json
check_hash release.json "$(jq -er .releaseManifest.sha256 "$temporary_directory/channel.json")"
verify release.json
jq -e --slurpfile channel "$temporary_directory/channel.json" --arg key "$trusted_key_id" '
  $channel[0] as $c |
  (.schemaVersion == $c.schemaVersion) and
  (.release.version == $c.version) and (.release.tag == $c.tag) and
  (.release.channel == "build") and
  (.release.readiness == $c.releaseReadiness) and
  (.deploymentDefinitionSha256 == $c.deploymentDefinitionSha256) and
  (.signing.keyId == $key) and
  (.artifacts.installerBootstrap.file == ("appsweet-install-" + $c.version + ".sh")) and
  (.artifacts.installerBootstrap.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
' "$temporary_directory/release.json" >/dev/null || fail 'manifest does not bind the selected build'
installer=$(jq -er .artifacts.installerBootstrap.file "$temporary_directory/release.json")
download "$release_base/backend-v$version/$installer" installer.sh
download "$release_base/backend-v$version/$installer.sigstore.json" installer.sh.sigstore.json
check_hash installer.sh "$(jq -er .artifacts.installerBootstrap.sha256 "$temporary_directory/release.json")"
verify installer.sh

# New installs choose one stable channel observation. Once selected, retain its signed bytes
# before invoking the versioned installer. Existing installs remain pinned even if the head moves.
if [ "$resume" = no ]; then
  download "$channel_base/$channel.json" latest-channel.json
  download "$channel_base/$channel.json.sigstore.json" latest-channel.json.sigstore.json
  verify latest-channel.json
  [ "$(hash "$temporary_directory/channel.json")" = "$(hash "$temporary_directory/latest-channel.json")" ] ||
    fail 'channel advanced during selection; rerun to select the new build'
  release_stage=$(mktemp -d "$install_directory/.release.XXXXXX")
  for retained in channel.json channel.json.sigstore.json release.json release.json.sigstore.json installer.sh installer.sh.sigstore.json; do
    cp "$temporary_directory/$retained" "$release_stage/$retained"
    chmod 600 "$release_stage/$retained"
  done
  sync
  mv "$release_stage" "$install_directory/release"
  release_stage=
  sync
else
  for retained in release.json installer.sh; do
    cmp -s "$temporary_directory/$retained" "$install_directory/release/$retained" || fail 'immutable release bytes changed'
  done
fi
sh "$temporary_directory/installer.sh" "$@" --channel "$channel" --version "$version" --selection-dir "$temporary_directory"
