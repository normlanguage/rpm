# Norm RPM repository

The Norm RPM repository currently targets Fedora 44 on x86_64. `normlang` bundles its application Java runtime under `/usr/lib/normlang`. `normlang-release` installs the signed DNF source and its public key; removing `normlang` leaves that source available.

Add the source once, then use DNF for the application lifecycle:

```sh
curl -fL https://normlanguage.github.io/rpm/RPM-GPG-KEY-normlang -o RPM-GPG-KEY-normlang
gpg --show-keys --fingerprint RPM-GPG-KEY-normlang
```

Confirm the primary fingerprint is `2A01 8018 2241 E5B8 18F0 1CA7 D18F 82B1 0380 DDB8`, then run:

```sh
sudo rpmkeys --import RPM-GPG-KEY-normlang
curl -fL https://normlanguage.github.io/rpm/normlang-release-latest.noarch.rpm -o normlang-release-latest.noarch.rpm
sudo rpmkeys --define '_pkgverify_level all' --checksig normlang-release-latest.noarch.rpm
sudo dnf --setopt=localpkg_gpgcheck=1 install ./normlang-release-latest.noarch.rpm
sudo dnf install normlang
sudo dnf upgrade normlang
sudo dnf remove normlang
```

The repository checks both RPM package signatures and signed repository metadata. The [publication workflow](.github/workflows/publish.yml) checks complete upstream Releases each day; publication is not immediate when an upstream release appears. It builds missing packages with the pinned [Norm packaging tools](https://github.com/normlanguage/Norm/blob/main/cli/compiler/scripts/rpm-repository.mjs), reuses the exact bytes of already published RPMs, and deploys only after signed-source install, upgrade, regular-user CLI/LSP/Native, and removal checks. A separate clean consumer checks the deployed HTTPS source.

Native Image builds also need a Linux C toolchain (GCC and system development libraries); see the [application build guide](https://github.com/normlanguage/Norm/blob/main/docs/tooling/application-build.md).

Run `sudo dnf upgrade` to include updates to `normlang-release`, which distributes repository configuration and the public key and requires Fedora's [expired-key plugin](https://dnf5.readthedocs.io/en/stable/libdnf5_plugins/expired-pgp-keys.8.html). Existing installations must receive this package while their current signing certificate is valid. The plugin can refresh an expired certificate of the same key from the configured source; recovery after a longer offline period and changes to a different key have not yet been validated.
