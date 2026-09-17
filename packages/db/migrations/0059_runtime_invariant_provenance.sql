-- 0059：结果行 provenance 增补 runtime_invariant（OC-C 运行期约束）

ALTER TABLE "__SCHEMA__".outcome_results
  DROP CONSTRAINT IF EXISTS outcome_results_provenance_check;

ALTER TABLE "__SCHEMA__".outcome_results
  ADD CONSTRAINT outcome_results_provenance_check CHECK (
    provenance IN (
      'manual',
      'module_inherited',
      'recorded',
      'ai_compiled',
      'legacy_assert',
      'runtime_invariant'
    )
  );
