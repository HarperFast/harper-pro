<img src="https://cdn.prod.website-files.com/6374050260446c42f94dc90f/68017805c782145469de5f0f_Harper%20Logo.png" width="30%">

# Harper Pro

Harper Pro is the source-available distribution of Harper, built on top of the [open-source Harper core](https://github.com/HarperFast/harper). It extends the core with enterprise features including multi-node replication, certificate management, and extended profiling and analytics. It is licensed under the [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).

Harper is a Node.js unified development platform that fuses database, cache, application, and messaging layers into one in-memory process. With Harper you can build ultra-high-performance services without boilerplate code and scale them horizontally.

**Key Features:**

**Unified Runtime:** Database, cache, application logic, and messaging all operate within a single in-memory Node.js process, eliminating external dependencies and reducing latency.

**In-Memory Performance:** Data and compute share memory space for microsecond-level access times and exceptional throughput under load.

**Native Messaging:** Built-in publish/subscribe messaging with Websockets and MQTT enables real-time communication between nodes and clients without external brokers.

**Developer Simplicity:** Annotate your data schema with `@export` to instantly generate REST APIs. Extend functionality by defining custom endpoints in JavaScript.

---

**Deploy with [Harper Fabric](https://fabric.harper.fast/#/sign-in) for Horizontal Scalability:** Distribute workloads across multiple Harper nodes by selecting your regions and latency targets.

---

## Getting Started

1. [Install Harper Pro](https://docs.harperdb.io/docs/getting-started/installation)
2. [Create Your First App](https://docs.harperdb.io/docs/getting-started/quickstart)

For full documentation, visit [docs.harperdb.io](https://docs.harperdb.io/).

## Open Source Core

Harper Pro is built on top of [Harper](https://github.com/HarperFast/harper), the open-source core licensed under Apache-2.0. The open-source core includes the foundational database, cache, application, and messaging layers. Harper Pro extends the core with additional enterprise features.

If you want to contribute to Harper or report bugs in the underlying platform, please do so in the [Harper repository](https://github.com/HarperFast/harper).

## License

Harper Pro is source-available software licensed under the [Elastic License 2.0 (ELv2)](https://www.elastic.co/licensing/elastic-license). You may view and modify the source, but you may not provide it as a hosted or managed service to third parties. See the LICENSE file for the full license text.

The open-source Harper core is licensed under Apache-2.0.

For more information, see the [License FAQ](https://www.harper.fast/resources/licensing-faq).

## Prerequisites

Harper Pro runs on any supported version of Node.js.
Node.js versions that are no longer supported [are marked as EoL on this page](https://nodejs.org/en/about/previous-releases).

Harper Pro has been tested on the following platforms:

- Linux on AMD64
- Linux on ARM64
- macOS on Intel
- macOS on Apple Silicon
- Windows

## Installing Harper Pro

```
npm install -g @harperfast/harper-pro
harper
```

Harper will prompt you for configuration options during install, and then automatically start after install.

## Contributing

Harper Pro does not accept external contributions. To contribute to the open-source core, see the [Harper contributing guide](https://github.com/HarperFast/harper/blob/main/CONTRIBUTING.md).
