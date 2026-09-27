# Norm RPM 软件源

[English](README.md)

Norm RPM 软件源目前面向 Fedora 44 x86_64。`normlang` 将应用 Java 运行时放在 `/usr/lib/normlang` 下。`normlang-release` 安装已签名的 DNF 软件源及其公钥；卸载 `normlang` 后仍会保留该软件源。

只需添加一次软件源，之后用 DNF 管理应用：

```sh
curl -fL https://normlanguage.github.io/rpm/RPM-GPG-KEY-normlang -o RPM-GPG-KEY-normlang
gpg --show-keys --fingerprint RPM-GPG-KEY-normlang
```

确认主钥指纹为 `2A01 8018 2241 E5B8 18F0 1CA7 D18F 82B1 0380 DDB8`，然后运行：

```sh
sudo rpmkeys --import RPM-GPG-KEY-normlang
curl -fL https://normlanguage.github.io/rpm/normlang-release-latest.noarch.rpm -o normlang-release-latest.noarch.rpm
sudo rpmkeys --define '_pkgverify_level all' --checksig normlang-release-latest.noarch.rpm
sudo dnf --setopt=localpkg_gpgcheck=1 install ./normlang-release-latest.noarch.rpm
sudo dnf install normlang
sudo dnf upgrade normlang
sudo dnf remove normlang
```

软件源同时检查 RPM 包签名和仓库元数据签名。[发布工作流](.github/workflows/publish.yml)每天检查完整的上游 Release；上游版本出现后不会立即发布。它使用固定版本的 [Norm 打包工具](https://github.com/normlanguage/Norm/blob/main/cli/compiler/scripts/rpm-repository.mjs)构建缺失包，精确复用已发布 RPM 的原始字节，并且仅在已签名软件源的安装、升级、普通用户 CLI/LSP/Native 运行和卸载检查通过后部署。另有独立的干净消费环境检查已部署的 HTTPS 软件源。

Native Image 构建还需要 Linux C 工具链（GCC 和系统开发库）；参见[应用构建指南](https://github.com/normlanguage/Norm/blob/main/docs/zh/tooling/application-build.md)。

运行 `sudo dnf upgrade` 可同时更新 `normlang-release`。该包分发软件源配置和公钥，并依赖 Fedora 的[过期公钥插件](https://dnf5.readthedocs.io/en/stable/libdnf5_plugins/expired-pgp-keys.8.html)。现有安装必须在当前签名证书仍有效时取得该包。插件可以从已配置的软件源刷新同一公钥的过期证书；长时间离线后的恢复及更换不同公钥尚未验证。
