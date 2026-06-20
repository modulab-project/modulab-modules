# modulab-modules

Official modules for ModuLab Core (https://modulab.app).

## Status

This repository is intentionally empty for now. ModuLab's v1 release ships Core itself, plus a fully functional Dashboard, Auth/IAM, and a working GitHub-based module discovery and installation pipeline, but with zero official feature modules included. Once Core has stabilized after v1, this repository will start hosting officially maintained modules (for example a household budget tracker, UniFi management, recipes, or an internal wiki) as the team validates the module pipeline end to end with real, supported modules.

## Relationship to modulab-community

modulab-community (https://github.com/modulab-project/modulab-community) is the discovery index for community-maintained modules. Modules in this repository (modulab-modules) are official and maintained by the ModuLab project itself, and are held to the same manifest.yaml and signing requirements described in modulab-module-sdk (https://github.com/modulab-project/modulab-module-sdk) and modulab-manifest-schema (https://github.com/modulab-project/modulab-manifest-schema), with mandatory cosign sign-blob signing rather than the optional signing allowed for community modules.

## Related repositories

modulab-core (https://github.com/modulab-project/modulab-core) is the Core backend and frontend. modulab-module-sdk (https://github.com/modulab-project/modulab-module-sdk) is the module starter kit. modulab-community (https://github.com/modulab-project/modulab-community) is the community module discovery index. modulab-manifest-schema (https://github.com/modulab-project/modulab-manifest-schema) defines the manifest.yaml JSON schema. modulab-docs (https://github.com/modulab-project/modulab-docs) holds the specification. modulab.app (https://github.com/modulab-project/modulab.app) is the landing page.

## License

AGPLv3, see LICENSE.
