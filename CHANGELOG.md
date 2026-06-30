# [1.2.0](https://github.com/jwulf/c8ctl-plugin-nano/compare/v1.1.0...v1.2.0) (2026-06-30)


### Features

* **nano:** notify once per day when a new release is available ([311cfb4](https://github.com/jwulf/c8ctl-plugin-nano/commit/311cfb4752c00d1b37387c1d56540b2405b31eda))
* **processos:** closed-alpha gate, auto-download, and update notifier ([5e9a311](https://github.com/jwulf/c8ctl-plugin-nano/commit/5e9a311f29cc36034807c62f9966cae575c74b35))

# [1.1.0](https://github.com/jwulf/c8ctl-plugin-nano/compare/v1.0.1...v1.1.0) (2026-06-30)


### Bug Fixes

* **release:** scope platform packages under [@nanobpm](https://github.com/nanobpm) to avoid name squatting ([536091d](https://github.com/jwulf/c8ctl-plugin-nano/commit/536091d89a5628822fa31132ce097bcf6b311faf))


### Features

* **nano:** add `nano update` to pull a new release on an existing install ([f261574](https://github.com/jwulf/c8ctl-plugin-nano/commit/f261574da4bfe0784e1e29b58bf5eef249b5e036))

## [1.0.1](https://github.com/jwulf/c8ctl-plugin-nano/compare/v1.0.0...v1.0.1) (2026-06-30)


### Bug Fixes

* **binary:** bundle nanobpmn 0.0.2 (44ad803) ([44339f2](https://github.com/jwulf/c8ctl-plugin-nano/commit/44339f2f2be25af10ddac6ad63b5479a848d7dfa))

# 1.0.0 (2026-06-28)


### Bug Fixes

* **binary:** bundle nanobpmn 0.0.1 (ed49485) ([ffa0f8e](https://github.com/jwulf/c8ctl-plugin-nano/commit/ffa0f8e9e98baf3741551730fcde0d9ecef01866))
* **binary:** bundle nanobpmn 0.0.1 (ed49485) ([daf9e33](https://github.com/jwulf/c8ctl-plugin-nano/commit/daf9e334cf4cf26a3013477acf4bd6ad537efac1))
* **ci:** authenticate platform-package npm publish during bootstrap ([0b22f17](https://github.com/jwulf/c8ctl-plugin-nano/commit/0b22f1720dc176cd38b0519f1562295a15e25f9e))
* **release:** defer platform packages npm rejects via spam detection ([928c704](https://github.com/jwulf/c8ctl-plugin-nano/commit/928c704825ff513b11dfe864a1080a8f45532e2e))
* **release:** set publishConfig.access public for provenance ([e034181](https://github.com/jwulf/c8ctl-plugin-nano/commit/e034181d473d3a1d8189cd12b8cc9112843bfddc))


### Features

* **chaos:** add nano pause/resume to simulate node failure and recovery ([0d1d00b](https://github.com/jwulf/c8ctl-plugin-nano/commit/0d1d00b511a76ce1e4d309fb178dbcdb2ac8f029))
* **dist:** ship nanobpmn binaries via per-platform npm packages ([2d1053f](https://github.com/jwulf/c8ctl-plugin-nano/commit/2d1053f9a29b864e867f5473ec1faec98e7313a8))
* **dist:** trigger npm release on binary updates via marker file ([0e802a7](https://github.com/jwulf/c8ctl-plugin-nano/commit/0e802a7ea775afdfb1123bbe57d91d254f17d342))
* **nano:** add --capture flag to enable trace capture on every node ([e21e19a](https://github.com/jwulf/c8ctl-plugin-nano/commit/e21e19a918682be777d99d552d067ab0a5882d0f))
* **nano:** default cluster-aware job activation replication ([189609a](https://github.com/jwulf/c8ctl-plugin-nano/commit/189609a8e3b6f1b35c878039e29ddb610b13d174))
* **nano:** default NANOBPMN_DURABILITY=async on every node, user-overridable ([e143290](https://github.com/jwulf/c8ctl-plugin-nano/commit/e143290291c37bc78cc4a43be3f3dc06c7704b65))
* **nano:** detect Camunda vs Nano via topology; guard start against collisions ([e32235c](https://github.com/jwulf/c8ctl-plugin-nano/commit/e32235cafc702eb3a38865aa806f6c9a9bfc503f))
* persistent workspace, clean command, and configurable bin/model-dir ([63a8f5d](https://github.com/jwulf/c8ctl-plugin-nano/commit/63a8f5d9e818526a18643de75adba2a9379649d7))
* **processos:** add command to manage a local ProcessOS instance ([ca32b6e](https://github.com/jwulf/c8ctl-plugin-nano/commit/ca32b6ed93f3af8a34b41b79751af00c0729488f))
* **processos:** auto-wire PROCESSOS_NANO_BIN for own-engine spawn mode ([0140907](https://github.com/jwulf/c8ctl-plugin-nano/commit/01409072c8c2ebf26c5ad9f8252f90ae80e5beba))
* **processos:** spawn a pilot Nano engine by default ([073f8b5](https://github.com/jwulf/c8ctl-plugin-nano/commit/073f8b55a0c25b296708e4bee8d0947c30b9792a))
* **status:** report cluster via /v2/topology, including clusters not started by c8ctl ([5213979](https://github.com/jwulf/c8ctl-plugin-nano/commit/52139796285b7e54bc4319ee1654add3326a4d60))
