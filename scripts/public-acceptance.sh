#!/bin/bash
set -euo pipefail

site="$1"
current="$2"
previous="$3"
user=normrpm-public
repo=/etc/yum.repos.d/normlang.repo
key=/etc/pki/rpm-gpg/RPM-GPG-KEY-normlang

test "$(id -u)" -eq 0
grep -qx 'ID=fedora' /etc/os-release
grep -qx 'VERSION_ID=44' /etc/os-release
test "$(rpm --eval '%{_arch}')" = x86_64
test "$site" = https://normlanguage.github.io/rpm
[[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$previous" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
test ! -e "$repo"
test ! -e "$key"
! rpm -q normlang >/dev/null 2>&1
! rpm -q normlang-release >/dev/null 2>&1
! id "$user" >/dev/null 2>&1

workspace="$(mktemp -d)"
cleanup() {
  status=$?
  set +e
  if [[ "${attempted_install:-}" == yes ]] && rpm -q normlang >/dev/null 2>&1; then dnf -y remove normlang; fi
  if [[ "${created_user:-}" == yes ]]; then userdel -r "$user"; fi
  rm -rf "$workspace"
  exit "$status"
}
trap cleanup EXIT

curl --fail --silent --show-error "$site/RPM-GPG-KEY-normlang" -o "$workspace/public.asc"
cmp "$workspace/public.asc" RPM-GPG-KEY-normlang
fingerprint="$(gpg --show-keys --with-colons "$workspace/public.asc" | awk -F: '$1 == "fpr" { print $10; exit }')"
test "$fingerprint" = "$(node -p 'require("./release.json").fingerprint')"
curl --fail --silent --show-error "$site/publication.json" -o "$workspace/publication.json"
curl --fail --silent --show-error "$site/publication.json.asc" -o "$workspace/publication.json.asc"
gpg --dearmor --output "$workspace/keyring.gpg" "$workspace/public.asc"
gpgv --keyring "$workspace/keyring.gpg" "$workspace/publication.json.asc" "$workspace/publication.json"
test "$(node -p 'require(process.argv[1]).packages[0].version' "$workspace/publication.json")" = "$current"
test "$(node -p 'require(process.argv[1]).packages[1].version' "$workspace/publication.json")" = "$previous"
curl --fail --silent --show-error "$site/normlang-release-latest.noarch.rpm" -o "$workspace/normlang-release-latest.noarch.rpm"
test "$(sha256sum "$workspace/normlang-release-latest.noarch.rpm" | cut -d' ' -f1)" = "$(node -p 'require(process.argv[1]).releasePackage.sha256' "$workspace/publication.json")"
rpmkeys --import "$workspace/public.asc"
rpmkeys --define '_pkgverify_level all' --checksig "$workspace/normlang-release-latest.noarch.rpm"
dnf -y --setopt=localpkg_gpgcheck=1 install "$workspace/normlang-release-latest.noarch.rpm"
test -f "$repo"
test -f "$key"
grep -Fx 'baseurl=https://normlanguage.github.io/rpm/fedora/44/$basearch' "$repo"
grep -Fx 'gpgcheck=1' "$repo"
grep -Fx 'repo_gpgcheck=1' "$repo"
useradd --create-home --shell /bin/bash "$user"
created_user=yes
install -d -o "$user" -g "$user" "/home/$user/project"
install -m 644 -o "$user" -g "$user" norm-tooling/cli/compiler/scripts/fixtures/hello.norm "/home/$user/project/hello.norm"
project_hash="$(sha256sum "/home/$user/project/hello.norm" | cut -d' ' -f1)"

attempted_install=yes
dnf -y install "normlang-$previous-1.x86_64"
runuser -u "$user" -- norm --version | grep -Fx "norm $previous"
dnf -y upgrade normlang
runuser -u "$user" -- norm --version | grep -Fx "norm $current"
runuser -u "$user" -- bash -c "cd /home/$user/project && norm run hello.norm" | grep -Fx 'Hello from Norm'
install -d -o "$user" -g "$user" "/home/$user/worktree/cli/compiler"
cp -a norm-tooling/cli/compiler/scripts "/home/$user/worktree/cli/compiler/"
chown -R "$user:$user" "/home/$user/worktree"
runuser -u "$user" -- env JAVA_HOME=/usr/lib/normlang/runtime node "/home/$user/worktree/cli/compiler/scripts/verify-lsp.mjs" /usr/lib/normlang "/home/$user/lsp-evidence" /usr/bin/norm
test "$(rpm -q --qf '%{VERSION}' normlang)" = "$current"
dnf -y remove normlang
attempted_install=no
test ! -e /usr/bin/norm
test ! -e /usr/lib/normlang
rpm -q normlang-release
test -f "$repo"
test -f "$key"
test "$(sha256sum "/home/$user/project/hello.norm" | cut -d' ' -f1)" = "$project_hash"
