# Daily report table font

StarVoiceDailyTable.ttf is a glyph subset of Noto Sans SC at weight 500, renamed for this application. It contains only fixed table headings, dates and digits.

Source: https://github.com/google/fonts/tree/main/ofl/notosanssc
Original font Git blob: fb0637bafbcd804fe32152370a1225990745b4bc
Original SHA-256: a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da
License: SIL Open Font License 1.1, included in OFL.txt.

Subset produced with fontTools 4.64.0; no system fonts or remote font loading are required at runtime.

The September 2026 monthly-table update preserves all 37 Unicode characters from the original subset and adds 14 characters: `/他其区台平情流留程舆言论评`. The resulting 51-character subset supports both the legacy headings and all nine monthly disposition headings, including `负面-评论区留言`, plus numeric `YYYY/M/D` dates and `MTD`.

Rebuild procedure: verify the original SHA-256 above; instantiate the source variable font at `wght=500`; subset the union of the original 37-character cmap and the current fixed table headings/dates; retain source copyright and OFL metadata; rename family IDs 1/16 to `StarVoice Daily Table`, full name to `StarVoice Daily Table Regular`, and PostScript name to `StarVoiceDailyTable-Regular`. Verify that the old cmap is a subset of the new cmap, weight remains 500, and the output has no variable-font `fvar` table.

Subset SHA-256: 2d5d5268f68a7fdb5e93ffb7a47deeda611c8e176ee795db669aaef7bcd74882
