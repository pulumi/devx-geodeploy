// Custom GeoDeploy visual theme: pale yellow background, purple + orange
// accent palette, dithered globe. This intentionally replaces an earlier
// Pulumi-dark-brand placeholder palette — these are not Pulumi brand colors,
// invent/adjust freely here as the app's own visual identity evolves.
//
// Every text/badge pairing below was checked with the Brand MCP server's
// `check_color_accessibility` tool (APCA) against the surface it's actually
// rendered on (page bg #FAF3D9 or card surface #FFFCF0/#F3E7B8) before being
// finalized — see the restyle work's report for the full set of Lc results.
export const theme = {
  color: {
    bg: "#FAF3D9", // page/scene background — pale yellow
    bodyText: "#241F2E", // near-black, purple-tinted — body copy on bg/surfaces
    headingText: "#1F1B21", // near-black — emphasis/heading text on bg/surfaces
    mutedText: "#4A4454", // dark warm grey — secondary text, passes on bg/surface50/surface100
    border: "#C9AE6B", // muted gold — hairline borders/dividers on the pale-yellow bg
    surface50: "#FFFCF0", // card/panel surface — near-white, sits above the page bg
    surface100: "#F3E7B8", // deeper warm surface — selected rows / secondary badges
    primary: "#6B21A8", // deep purple — brand primary, titles, ocean side of the globe shader
    accent: "#FF5A00", // bold, saturated orange — atmosphere glow, arcs, land side of the globe shader
    demandBlue: "#1D4ED8", // blue — demand-geo points ("where users are")
    selectionHighlight: "#0E7490", // teal — selected point/row ring, distinct from every other hue in use
    successBadge: "#14532D", // dark green fill — provisioned succeeded (light text sits on top)
    successText: "#166534", // green text on light surfaces
    failureBadge: "#9F1D23", // dark red fill — provisioned failed (light text sits on top)
    failureText: "#B91C1C", // red text on light surfaces
    warningBadge: "#78350F", // dark amber fill — refused-to-apply (light text sits on top)
    warningText: "#92400E", // amber text on light surfaces
    infoText: "#1E3A8A", // navy — "not yet provisioned" (calm, not alarming)
    notAppliedPin: "#5C5666", // muted/unlit pin
    labelText: "#FFFFFF", // globe region/CPU-utilization label sprites — plain white for legibility against the varied purple/orange globe and magenta/yellow skybox behind them
    sidebarGradientEnd: "#FFD9C2", // soft pale salmon — paired with bg's pale yellow for the sidebar's background gradient
  },
  font: {
    sans: "'VT323', monospace",
    display: "'VT323', monospace", // headings/titles only — purple, per theme.color.primary
    mono: "'Monaspace Neon', menlo, consolas, ui-monospace, monospace",
  },
  space: { xs: 2, s: 4, m: 8, l: 12, xl: 16, "2x": 24, "3x": 32, "4x": 48 },
  dialogWidth: { small: 632, medium: 752, large: 872 },
} as const;

export type Theme = typeof theme;
