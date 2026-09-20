-- Imported demonstrations preserve their provenance in runtime business results.
ALTER TABLE "__SCHEMA__".outcome_results
  DROP CONSTRAINT outcome_results_provenance_check;
ALTER TABLE "__SCHEMA__".outcome_results
  ADD CONSTRAINT outcome_results_provenance_check CHECK (
    provenance IN ('manual', 'module_inherited', 'recorded', 'ai_compiled', 'legacy_assert', 'runtime_invariant', 'imported')
  );
