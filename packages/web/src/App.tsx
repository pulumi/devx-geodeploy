import { useEffect, useMemo, useState } from "react";
import { theme } from "./theme";
import { useLiveData } from "./useLiveData";
import { Sidebar } from "./Sidebar";
import { Globe } from "./Globe";
import { RegionModal } from "./RegionModal";
import { ResizePanel } from "./ResizePanel";
import { Wizard } from "./Wizard";
import type { DeploymentPlan } from "./types";

export function App() {
  const { plan: livePlan, apply, monitor, applyProgress, loaded } = useLiveData();
  const [showResizePanel, setShowResizePanel] = useState(false);
  // The single source of truth for "which region is selected" — Sidebar rows
  // and Globe pins both call the same onSelect, so they can never desync
  // into two different modals.
  const [selectedGeoId, setSelectedGeoId] = useState<string | null>(null);

  // Wizard visibility: shown whenever there's nothing to look at yet (once
  // the initial load has actually confirmed that — `loaded` distinguishes
  // "still loading" from "confirmed absent" so the wizard doesn't flash on
  // then off during the fallback fetch/SSE handshake), or on demand via the
  // Sidebar's "New Plan" button once a plan already exists.
  const [showWizard, setShowWizard] = useState(false);
  // Optimistic plan from the wizard's own POST response, shown immediately
  // instead of waiting the ~75ms for the SSE watcher's debounced dispatch.
  // useLiveData's own next "plan" event (same file, same shape) supersedes
  // this the moment it arrives — this is purely a fill-in for that gap.
  const [optimisticPlan, setOptimisticPlan] = useState<DeploymentPlan | null>(null);
  // Surfaced by the wizard's POST /api/plan response when this plan's own
  // decision engine picked a DNS provider but no matching config was
  // supplied — see uiCmd.ts's handlePlanSubmission. Shown here (not inside
  // Wizard itself) since the Wizard unmounts immediately on success; this is
  // exactly where the user needs to see it, right by the Deploy button.
  const [dnsWarning, setDnsWarning] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && livePlan === null && optimisticPlan === null) setShowWizard(true);
  }, [loaded, livePlan, optimisticPlan]);

  // Once the live feed catches up with (or overtakes) the optimistic plan,
  // stop overriding it — livePlan becomes the single source of truth again.
  useEffect(() => {
    if (livePlan !== null) setOptimisticPlan(null);
  }, [livePlan]);

  const plan = livePlan ?? optimisticPlan;

  const selectedRegion = useMemo(
    () => plan?.regions.find((r) => r.geoId === selectedGeoId) ?? null,
    [plan, selectedGeoId],
  );

  if (showWizard) {
    return (
      <Wizard
        onPlanCreated={(newPlan, warning) => {
          setOptimisticPlan(newPlan);
          setDnsWarning(warning ?? null);
          setShowWizard(false);
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        background: theme.color.bg,
        color: theme.color.bodyText,
        fontFamily: theme.font.sans,
      }}
    >
      <Sidebar
        plan={plan}
        apply={apply}
        monitor={monitor}
        applyProgress={applyProgress}
        dnsWarning={dnsWarning}
        onDismissDnsWarning={() => setDnsWarning(null)}
        loaded={loaded}
        selectedGeoId={selectedGeoId}
        onSelect={setSelectedGeoId}
        onNewPlan={() => {
          setDnsWarning(null);
          setShowWizard(true);
        }}
        onOpenResize={() => setShowResizePanel(true)}
      />
      <div style={{ flex: 1, position: "relative" }}>
        <Globe plan={plan} apply={apply} monitor={monitor} selectedGeoId={selectedGeoId} onSelect={setSelectedGeoId} />
      </div>
      {selectedRegion && plan && (
        <RegionModal
          plan={plan}
          region={selectedRegion}
          apply={apply}
          onClose={() => setSelectedGeoId(null)}
        />
      )}
      {showResizePanel && monitor && (
        <ResizePanel monitor={monitor} plan={plan} onClose={() => setShowResizePanel(false)} />
      )}
    </div>
  );
}
