# v20.1 Hotfix

Fixed the production JavaScript error `hrRender is not defined`.

Changes:
- Added the missing `hrRender()` implementation for the House Research Challenger card.
- Added isolated error guards around optional House Research render/recording modules so an auxiliary research failure cannot abort the main feed/render loop.
- Kept the v7.1 Champion prediction engine and existing PDF/House Day/run/ledger architecture intact.

Validation:
- JavaScript syntax check: passed with Node `--check`.
- All DOM IDs referenced by `$()` / `setText()` in the HTML are present.
- `hrRender` is now defined before `hrRenderAll()` is executed.
