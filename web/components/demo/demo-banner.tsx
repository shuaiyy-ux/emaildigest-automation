/** Fixed top strip on every page in DEMO_MODE. Height comes from --demo-banner-h (globals.css). */
export function DemoBanner() {
  return (
    <div role="note" className="demo-banner">
      Anonymized sample data. Names, addresses, IDs, phone numbers and amounts are replaced; dates are shifted.
    </div>
  );
}
