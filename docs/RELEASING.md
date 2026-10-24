# Releasing

For maintainers. A release is a git tag `vX.Y.Z`; everything else follows from it.

1. **Finish the work on `main`** (CI green: backend tests, frontend build, shell checks, deploy,
   arm64, and the in-app update end-to-end test).
2. **Write the changelog** in [CHANGELOG.md](../CHANGELOG.md): add a `## [X.Y.Z] - date` section above
   the previous one, written for the people who run HomeVault (it is shown under *What's new* in the
   app's update screen).
3. **Set the version** in both packages (this also updates their lockfiles):

   ```sh
   (cd backend  && npm version X.Y.Z --no-git-tag-version)
   (cd frontend && npm version X.Y.Z --no-git-tag-version)
   scripts/check-version.sh vX.Y.Z     # must say "consistent"
   ```

   Commit and merge that through a pull request.
4. **Tag and push:**

   ```sh
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

5. The **Release** workflow then:
   - refuses to continue if the tag, the package versions and the changelog disagree,
   - builds and pushes `ghcr.io/<owner>/<repo>` and `ghcr.io/<owner>/<repo>-updater` for
     `linux/amd64` and `linux/arm64` (tags `X.Y.Z`, `X.Y`, `latest`), with provenance and an SBOM,
   - warns if the package cannot be pulled anonymously,
   - creates the GitHub release with the changelog section as notes and marks it *latest*.

6. **Within hours, every installation notices it**: administrators see the update notice and can
   install it from Settings. Check that the release is not a draft or pre-release; those are
   deliberately ignored by the update check.

## One-time setup

- **Make the container packages public** (GitHub → your profile or organization → Packages → each
  package → Package settings → Change visibility). New packages can start private, and then neither
  the installer nor the Update button can download them. The release workflow warns when this is
  the case.
- Enable **private vulnerability reporting** (Settings → Code security) so [SECURITY.md](SECURITY.md)
  has somewhere to send reports.

## Hotfixes

Branch from the tag, fix, bump the patch version, update the changelog and tag again. Installations
update straight to the newest release; there is no need to release in between.

## Checking a release by hand

```sh
docker run --rm --platform linux/arm64 ghcr.io/<owner>/<repo>:X.Y.Z node -p process.arch      # arm64
docker buildx imagetools inspect ghcr.io/<owner>/<repo>:X.Y.Z                                  # both platforms listed
```
