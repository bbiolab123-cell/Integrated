// Domain knowledge for the most common plate-reader assays. The analyzer injects
// the matching guide so the AI knows WHAT is being measured, the CORRECT
// quantification, the expected controls, pass criteria, and common failure modes —
// i.e. so it reasons like a bench scientist instead of describing numbers generically.

export interface AssayGuide {
  key: string;
  label: string;
  /** keywords matched (case-insensitive) against assay type + notes + read type */
  matches: string[];
  measures: string;
  quantification: string;
  /** The actual equation(s) the AI should apply — surfaced so the math is explicit, not paraphrased. */
  keyFormula?: string;
  controls: string;
  passCriteria: string;
  failureModes: string;
}

export const ASSAY_GUIDES: AssayGuide[] = [
  {
    key: "viability",
    label: "Cell viability / cytotoxicity (MTT, MTS, XTT, CCK-8, resazurin/AlamarBlue, CellTiter-Glo)",
    matches: ["mtt", "mts", "xtt", "cck-8", "cck8", "resazurin", "alamar", "celltiter", "ctg", "viability", "cytotox", "proliferation"],
    measures: "Metabolic activity (formazan/ATP/resorufin signal) as a proxy for the number of live, metabolically active cells.",
    quantification:
      "Normalize each well to % viability = 100 × (sample − blank) / (untreated/vehicle control − blank). For a dose series, fit a 4-parameter logistic and report IC50/EC50 in the dose unit (state the assumed dose axis); flag if IC50 is outside the tested range. Report the % viability range across doses.",
    keyFormula: "% viability = 100 × (sample − blank) / (vehicle − blank). 4PL: Y = Bottom + (Top − Bottom) / (1 + (X / IC50)^HillSlope).",
    controls: "Untreated/vehicle = 100% viability; media-only blank = background; a positive kill control (e.g. staurosporine, Triton X-100, high-dose reference) = assay floor.",
    passCriteria: "Z' ≥ 0.5, replicate CV < 15%, a clear monotonic dose-response, vehicle control near 100%, kill control near 0%.",
    failureModes: "Edge-well evaporation inflating outer rows/columns; vehicle (DMSO) toxicity if >0.5–1%; flat dose-response (compound inactive OR dose range wrong); blank not subtracted; seeding-density variation.",
  },
  {
    key: "pharmacology",
    label: "Dose-response / drug potency (IC50 / EC50 pharmacology)",
    matches: ["dose-response", "dose response", "ic50", "ec50", "inhibitor", "inhibition", "agonist", "antagonist", "potency", "drug response", "compound screen", "titration"],
    measures: "Target activity, inhibition, or binding as a function of compound concentration — used to rank compound potency.",
    quantification:
      "Fit a 4-parameter logistic (4PL) to normalized response vs log(concentration). Report the potency (IC50 for inhibition, EC50 for activation) WITH units and 95% CI, the Hill slope, the top/bottom plateaus, and goodness-of-fit (R²). Normalize to % effect using the assay's full/zero-effect controls. Explicitly flag when the curve does not reach both plateaus — the IC50/EC50 is then extrapolated and unreliable.",
    keyFormula: "% inhibition = 100 × (1 − (sample − min) / (max − min)). 4PL: Y = Bottom + (Top − Bottom) / (1 + (X / IC50)^HillSlope). IC50 = concentration at half-maximal effect.",
    controls: "Full-activity / no-inhibitor (vehicle) = 0% inhibition; saturating reference inhibitor = 100% inhibition; blank. For agonists, unstimulated = 0% and a max-response reference = 100%.",
    passCriteria: "Full sigmoid with both top and bottom plateaus captured, Hill slope ≈ 0.5–2, R² > 0.95, Z' ≥ 0.5, monotonic response.",
    failureModes: "Dose range misses the IC50 (no plateau → extrapolated value); very steep or shallow Hill slope (aggregation / non-specific / cooperativity); compound insoluble at the top dose; vehicle (DMSO) effect; biphasic curve (off-target at high dose).",
  },
  {
    key: "enzyme-kinetics",
    label: "Enzyme kinetics (Michaelis-Menten, kinetic reads)",
    matches: ["kinetic", "michaelis", "menten", " km", "vmax", "kcat", "initial rate", "enzyme activity", "substrate", "turnover", "velocity"],
    measures: "Reaction rate as a function of substrate concentration, from time-course (kinetic) reads of product formation or substrate loss.",
    quantification:
      "Compute the initial velocity V0 from the LINEAR early portion of each progress curve (slope = ΔSignal/Δtime, converted to concentration/time via the extinction coefficient or a product standard). Then fit V0 vs [S] to the Michaelis-Menten equation and report Km and Vmax (and kcat = Vmax/[E] when enzyme concentration is known). Prefer nonlinear regression over Lineweaver-Burk linearization.",
    keyFormula: "V0 = slope of linear phase. Michaelis-Menten: V = Vmax·[S] / (Km + [S]). kcat = Vmax / [E]total. Linearizations (report only if asked, they distort error): Lineweaver-Burk 1/V vs 1/[S]; Eadie-Hofstee V vs V/[S]; Hanes-Woolf [S]/V vs [S].",
    controls: "No-enzyme and no-substrate blanks; a known-activity reference enzyme; a product standard for unit conversion.",
    passCriteria: "Initial rates taken from the linear phase (R² > 0.98), substrate range spanning below and above Km, clear approach to saturation.",
    failureModes: "Rates read past the linear phase (substrate depletion underestimates V0); substrate range entirely below Km (no saturation, unstable fit); inner-filter effect at high substrate; enzyme instability over the read.",
  },
  {
    key: "binding-kinetics",
    label: "Binding / affinity (Kd, saturation & real-time interaction)",
    matches: ["binding", " kd", "affinity", "association", "dissociation", "saturation binding", "competitive inhibition", "biolayer", "scatchard"],
    measures: "The interaction between two molecules (ligand-receptor, antibody-antigen) as bound signal vs concentration or vs time.",
    quantification:
      "For equilibrium saturation binding, fit a one-site model to get Kd and Bmax. For real-time interaction, fit association (kon) and dissociation (koff) phases; Kd = koff/kon. For competitive inhibition, convert IC50 to Ki with the Cheng-Prusoff correction. Report Kd/Ki with units and goodness-of-fit.",
    keyFormula: "One-site saturation: Y = Bmax·X / (Kd + X). Real-time: Kd = koff / kon. Cheng-Prusoff: Ki = IC50 / (1 + [S]/Km).",
    controls: "Non-specific-binding (NSB) wells; total-binding wells; a reference ligand of known affinity.",
    passCriteria: "Saturation reached (curve plateaus at Bmax), low NSB, R² > 0.95, concentration range spanning Kd.",
    failureModes: "Concentration range below Kd (no saturation, unreliable Kd); high NSB masking specific binding; ligand depletion at low Kd; non-equilibrium reads for equilibrium models.",
  },
  {
    key: "elisa",
    label: "ELISA / immunoassay (absorbance or fluorescence)",
    matches: ["elisa", "immunoassay", "sandwich", "antibody", "antigen", "450", "tmb"],
    measures: "Concentration of a specific analyte (protein/cytokine/antibody) via an enzyme- or fluor-linked antibody signal.",
    quantification:
      "Fit the standard curve (4PL/5PL for sigmoidal, linear only in the linear range), report R², then interpolate unknowns and back-calculate concentration × dilution factor. Report values in the standard's unit (e.g. pg/mL). ELISA signal variance typically INCREASES with concentration — an unweighted least-squares fit is biased toward the high-concentration standards at the expense of accuracy near the sensitive low end; use 1/Y or 1/Y² weighting if the fitting method supports it, and say so if it doesn't. Back-calculate each standard from the fitted curve and flag the curve as questionable if any standard is off by more than ±20% of its nominal value — this is standard QC practice, not optional. State the LLOQ/ULOQ (lowest/highest reliably quantifiable standard) and flag any unknown that falls outside that range as non-quantifiable, not just 'out of range'.",
    keyFormula: "Concentration = interpolate(signal from standard curve) × dilution factor. 4PL as above; use only within the fitted standard range (LLOQ–ULOQ).",
    controls: "Standard dilution series; blank/zero standard; non-specific binding (NSB); optional high/low QC samples.",
    passCriteria: "Standard-curve R² > 0.98, all standards back-calculate within ±20% of nominal, QC recovery 80–120%, low NSB, unknowns falling within LLOQ–ULOQ (not extrapolated).",
    failureModes: "Signal above the top standard (needs further dilution); high background (insufficient washing); hook effect at very high analyte; edge effects; saturated absorbance (>~3.0 OD); unweighted fit distorting the low end of the curve.",
  },
  {
    key: "protein",
    label: "Protein quantification (Bradford, BCA, Lowry)",
    matches: ["bradford", "bca", "lowry", "protein assay", "protein quant", "total protein"],
    measures: "Total protein concentration via a colorimetric reaction proportional to protein amount.",
    quantification: "Fit a BSA standard curve (linear or quadratic in range), report R², interpolate samples, multiply by dilution. Report mg/mL or µg/µL.",
    controls: "BSA standard series; buffer blank.",
    passCriteria: "R² > 0.99, samples within the standard range, replicate CV < 10%.",
    failureModes: "Samples above the linear range (dilute and re-read); detergent/reducing-agent interference (Bradford vs BCA choice); uneven incubation time across the plate.",
  },
  {
    key: "reporter",
    label: "Reporter / luciferase / fluorescent-reporter assay",
    matches: ["luciferase", "luc", "reporter", "gfp", "renilla", "dual-luc", "luminescence reporter", "promoter"],
    measures: "Transcriptional/pathway activity via reporter enzyme or fluorophore output.",
    quantification: "Report fold-change vs the relevant control; for dual-luciferase, normalize firefly to Renilla (internal control) before computing fold-change. State the reference condition. IMPORTANT CAVEAT: the normalizer is not always inert — some compounds directly affect luciferase enzyme activity itself (anaesthetics attenuate firefly signal, proteasome inhibitors stabilize firefly protein, some compounds increase Renilla output), which can look like a real treatment effect but is actually an assay artifact. If both firefly AND Renilla raw signals moved in the same direction, say so explicitly — the ratio alone can hide this.",
    controls: "Untreated/vehicle baseline; positive inducer; for dual-luc an internal normalization reporter.",
    passCriteria: "Robust window over baseline (fold-change clearly > 1 with low CV), internal control stable across wells, raw (unnormalized) signals for both reporters checked for consistency.",
    failureModes: "Transfection-efficiency variation (why dual-luc normalization matters); signal decay over read time; well-to-well crosstalk for luminescence; the compound itself altering luciferase activity rather than the biology being tested (check raw signals, not just the ratio).",
  },
  {
    key: "qpcr",
    label: "qPCR / RT-qPCR gene expression (ΔΔCt)",
    matches: ["qpcr", "rt-pcr", "rtpcr", "ddct", "delta ct", "ct value", "cq", "gene expression", "taqman", "sybr", "quantstudio", "cfx", "amplification"],
    measures: "Relative transcript (or DNA) abundance via the cycle threshold (Ct/Cq) at which amplification crosses detection.",
    quantification:
      "Use the ΔΔCt method: ΔCt = Ct(target) − Ct(reference/housekeeping gene); ΔΔCt = ΔCt(sample) − ΔCt(calibrator/control); fold change = 2^(−ΔΔCt). This assumes ~100% efficiency — if primer efficiency differs, use the efficiency-corrected (Pfaffl) method. Name the reference gene and calibrator condition explicitly. For absolute quantity, interpolate off a standard curve instead.",
    keyFormula: "ΔCt = Ct(target) − Ct(ref). ΔΔCt = ΔCt(sample) − ΔCt(calibrator). Fold change = 2^(−ΔΔCt). Efficiency = 10^(−1/slope) − 1.",
    controls: "Endogenous reference/housekeeping gene(s) (e.g. GAPDH, ACTB); no-template control (NTC); no-reverse-transcriptase (−RT) control; calibrator/untreated sample.",
    passCriteria: "NTC shows no amplification, reference gene stable across conditions, technical-replicate Ct SD < 0.3, primer efficiency 90–110%, single melt peak (SYBR).",
    failureModes: "Unstable housekeeping gene (invalidates normalization); NTC contamination; Ct > 35 (near detection limit, unreliable); primer-dimers/multiple melt peaks; unequal RNA input.",
  },
  {
    key: "microbial-growth",
    label: "Microbial growth / OD600 (growth curves, MIC)",
    matches: ["od600", "od 600", "growth curve", "bacterial", "microbial", "optical density", "turbidity", "doubling time", "mic", "colony"],
    measures: "Culture density over time via light scattering (absorbance) at ~600 nm.",
    quantification:
      "Subtract the media-only blank, identify the exponential phase, and compute the specific growth rate µ from the slope of ln(OD) vs time; doubling time = ln2/µ. For MIC assays, report the lowest concentration showing no visible growth (blank-level OD). Note OD600 is only linear up to ~1.0 — dilute or use path-length correction above that.",
    keyFormula: "µ = ln(OD₂/OD₁) / (t₂ − t₁) over the exponential phase. Doubling time = ln(2)/µ. MIC = lowest [drug] with OD ≈ blank.",
    controls: "Media-only blank (sterility + background); untreated growth control; for MIC, a known-antibiotic reference and a positive growth well.",
    passCriteria: "Clear lag / exponential / stationary phases, blank-subtracted, monotonic growth in the untreated control, replicates consistent.",
    failureModes: "OD saturation/non-linearity above ~1.0 (dilute); lid condensation or bubbles scattering light; cell settling in long runs; edge-well evaporation; reading before exponential phase.",
  },
  {
    key: "apoptosis",
    label: "Apoptosis / enzyme-activity (caspase-Glo, etc.)",
    matches: ["apopto", "caspase", "caspase-3", "caspase-glo", "annexin"],
    measures: "Enzyme (e.g. caspase-3/7) activity as a marker of apoptosis.",
    quantification: "Report fold-change in activity vs untreated; pair with a viability readout to distinguish apoptosis from total cell loss.",
    controls: "Untreated baseline; a known apoptosis inducer (e.g. staurosporine) as positive control.",
    passCriteria: "Clear induction over baseline in the positive control; consistent replicates.",
    failureModes: "Confounding by total cell number (normalize to viability); signal plateau if substrate-limited.",
  },
  {
    // Generic fallback — kept LAST so named assays (elisa, protein, …) match first.
    key: "standard-curve",
    label: "Standard curve / concentration interpolation (general)",
    matches: ["standard curve", "calibration curve", "calibration", "interpolat", "back-calculate", "back calculate", "calibrator", "unknown concentration"],
    measures: "The concentration of unknown samples, back-calculated from a curve of known-concentration standards.",
    quantification:
      "Fit the standard series: linear within the linear range, otherwise 4PL/5PL (sigmoidal) or quadratic. Report R². Interpolate unknowns ONLY within the fitted range (never extrapolate past the top/bottom standard), then multiply by the dilution factor. Report in the standard's unit. Back-calculate each standard from its own fitted curve — flag the curve if any standard misses its nominal value by more than ±20%, a standard QC check most people skip. State the LLOQ/ULOQ and mark any unknown outside that range as non-quantifiable.",
    keyFormula: "concentration = interpolate(signal, standard curve) × dilution factor. Quantify only within the fitted standard range (LLOQ–ULOQ).",
    controls: "A standard dilution series spanning the expected sample range; a zero/blank standard; optional high/low QC samples.",
    passCriteria: "R² > 0.98 (immunoassay) or > 0.99 (protein), all standards back-calculate within ±20% of nominal, unknowns fall inside LLOQ–ULOQ, QC recovery 80–120%.",
    failureModes: "Unknowns above the top standard (dilute and re-read); extrapolation beyond the curve; too few standards to define curvature; saturated signal flattening the top of the curve.",
  },
];

const GENERIC_PLATE_GUIDE: AssayGuide = {
  key: "generic",
  label: "Plate-reader assay (general)",
  matches: [],
  measures: "An optical signal (absorbance / fluorescence / luminescence) per well, proportional to the assay's analyte or cellular readout.",
  quantification:
    "Identify the readout from the protocol, then apply the standard method: normalize to controls, fit a standard or dose-response curve where applicable, and report the key quantity (concentration, % effect, IC50/EC50, or fold-change) with units.",
  controls: "Positive control, negative/vehicle control, and a media/buffer blank.",
  passCriteria: "Z' ≥ 0.5 when controls exist, replicate CV < 20%, no strong edge effects, controls behaving as expected.",
  failureModes: "Edge effects (evaporation), high CV (pipetting), saturated or floored signal, missing blank subtraction.",
};

/** Pick the most relevant assay guide from free text (assay type + notes + read type). */
export function matchAssayGuide(text: string): AssayGuide {
  const hay = (text || "").toLowerCase();
  for (const g of ASSAY_GUIDES) {
    if (g.matches.some((m) => hay.includes(m))) return g;
  }
  return GENERIC_PLATE_GUIDE;
}

/** Render the matched guide as a prompt block. */
export function assayGuidanceBlock(text: string): string {
  const g = matchAssayGuide(text);
  return [
    `ASSAY CONTEXT — this looks like: ${g.label}`,
    `• What it measures: ${g.measures}`,
    `• Correct quantification: ${g.quantification}`,
    ...(g.keyFormula ? [`• Key formula(s): ${g.keyFormula}`] : []),
    `• Expected controls: ${g.controls}`,
    `• Pass criteria: ${g.passCriteria}`,
    `• Common failure modes to check: ${g.failureModes}`,
  ].join("\n");
}

// Always-injected quantification protocol — the fixed decision process the AI
// follows on every plate, regardless of assay. Mirrors docs/DATA_QUANTIFICATION_PROTOCOL.md.
// Kept tight to limit token cost; assay-specific detail comes from the matched guide.
export const QUANTIFICATION_PROTOCOL = `DATA QUANTIFICATION PROTOCOL — follow this on every plate before giving a verdict:
1. IDENTIFY the readout (absorbance/fluorescence/luminescence/OD/Ct) and the intent (concentration? potency? rate? growth? relative expression?) from the protocol/notes.
2. PICK THE METHOD:
   • Unknown concentration → fit a STANDARD CURVE (linear in-range, else 4PL/5PL or quadratic), report R², interpolate ONLY within range, apply dilution factor.
   • Compound potency → 4PL DOSE-RESPONSE on log(conc): report IC50/EC50 (units + 95% CI), Hill slope, plateaus, R²; flag if plateaus not captured.
   • Enzyme rate → INITIAL VELOCITY from the linear phase, then Michaelis-Menten Km/Vmax.
   • Binding → Kd from saturation (Y=Bmax·X/(Kd+X)) or kon/koff (Kd=koff/kon).
   • Growth over time → exponential-phase rate µ=ln(OD₂/OD₁)/Δt and doubling time ln2/µ.
   • Relative expression → ΔΔCt, fold change = 2^(−ΔΔCt).
3. COMPUTE ASSAY QC when controls exist: Z'-factor = 1 − 3(σp+σn)/|μp−μn| (≥0.5 excellent, 0–0.5 marginal, <0 fail); signal-to-background = μsig/μblank; signal-to-noise = (μp−μn)/√(σp²+σn²); %CV = 100·SD/mean per replicate group (<10–15% good). BE HONEST ABOUT Z'-FACTOR'S LIMITS: it assumes roughly normal, low-outlier control distributions and its conventional thresholds (0.5, 0) are convention, not a proven statistical cutoff — don't present a marginal or failing Z' as a hard verdict on its own, especially for phenotypic/primary-cell/high-content assays where a few outlier wells can deflate it artificially.
4. CHECK REPLICATE INTEGRITY: if the "replicates" look like the same dilution/sample pipetted into adjacent wells (not independently prepared), flag this as PSEUDOREPLICATION — their tight agreement reflects pipetting consistency, not true biological/technical independence, and any CV%/CI computed from them understates real uncertainty. Say so explicitly rather than reporting a falsely confident CV.
5. CHECK PLATE HEALTH. When the context contains "spatial_diagnostics", the edge effect and row/column bias have ALREADY BEEN MEASURED from the well values — those numbers are fact. Quote them and build your interpretation on them. Never contradict them, never claim an edge effect the diagnostics did not flag, and never say the plate "may have" an artifact the diagnostics explicitly ruled out. If they flagged nothing, say the plate is spatially clean and move on. Use the logic below to interpret the measurement, not to replace it:
   • High background/signal EVERYWHERE (not spatially patterned) → suspect reagent quality, blocking, or wash-step consistency, not the plate layout.
   • High/low signal concentrated at the PERIPHERAL wells only → classic edge effect (evaporation, temperature gradient during incubation) — recommend excluding border wells or using only the inner 60 wells next time.
   • Signal drifting directionally over the READ SEQUENCE/TIME → reagent instability or read-order timing artifact, not a real biological trend.
   Also check outliers (>2–3 SD) and saturated/floored signal. Recommend a heatmap/scatter when spread is high.
6. REPORT hard numbers with units and specific well IDs; state assumptions (dose axis, which wells are controls); separate technical artifact from real biology; give a confidence level.
Never invent a standard curve, dose axis, or control set that isn't in the data — if it's missing, say what's needed.`;

/**
 * Full analysis grounding: the always-on quantification protocol + the
 * assay-specific guide matched from the experiment text. Use this to ground
 * plate-data analysis and copilot chat.
 */
export function analysisKnowledgeBlock(text: string): string {
  return `${QUANTIFICATION_PROTOCOL}\n\n${assayGuidanceBlock(text)}`;
}
