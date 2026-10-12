# Support

Analytics Hub for Microsoft Copilot is **experimental**.
It is **not supported through Microsoft support channels**. Use this repository's
[GitHub issues](https://github.com/microsoft/AnalyticsHub-Dashboard/issues)
to ask for help, report bugs or suggest improvements. Assistance is best effort;
there is no guaranteed response time or support service-level agreement.

## Before opening an issue

Start with the [README](README.md), then follow the setup and troubleshooting
guidance for where you installed it:

- [Fabric](fabric/README.md), including the [app](app/README.md)
- [Azure](azure/README.md)
- [The installer](installer/README.md), including its **Problems** section

For the Power BI templates (Power Automate + Dataverse, SharePoint, local CSV), use
[ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues).

Search existing issues for the same symptom. For a new bug report, include:

- Fabric or Azure, the installer version (shown at the top of the installer window)
  and the step that failed.
- Whether the problem is in the installer, the app, a notebook or job run, or a Power BI report.
- Whether you used demo mode (sample data) or your own data.
- Optional sources enabled, relevant script/runtime versions, and steps to reproduce.
- Expected behaviour and the exact error message, with sensitive values removed.

Use a minimal fabricated example where possible. Do not post tenant exports,
credentials, user identities, prompts or private solution packages. Redact logs
and screenshots before sharing them.

## Security and contributions

Do **not** report security vulnerabilities in public issues. Follow the private
reporting instructions in [SECURITY.md](SECURITY.md).

To propose a fix or documentation change, see [CONTRIBUTING.md](CONTRIBUTING.md)
and the [Code of Conduct](CODE_OF_CONDUCT.md).
