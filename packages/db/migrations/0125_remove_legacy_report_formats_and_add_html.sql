-- 0125：清理历史 docx 与 pdf 报告制品数据，收敛 artifacts.kind 为 report_html
DELETE FROM "__SCHEMA__".report_revision_outputs
WHERE artifact_id IN (
  SELECT id FROM "__SCHEMA__".artifacts WHERE kind IN ('report_docx', 'report_pdf')
) OR format IN ('docx', 'pdf');

DELETE FROM "__SCHEMA__".export_job_artifacts
WHERE artifact_id IN (
  SELECT id FROM "__SCHEMA__".artifacts WHERE kind IN ('report_docx', 'report_pdf')
);

DELETE FROM "__SCHEMA__".stored_objects
WHERE artifact_id IN (
  SELECT id FROM "__SCHEMA__".artifacts WHERE kind IN ('report_docx', 'report_pdf')
);

DELETE FROM "__SCHEMA__".artifacts
WHERE kind IN ('report_docx', 'report_pdf');

ALTER TABLE "__SCHEMA__".artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE "__SCHEMA__".artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN ('brand_logo', 'report_material', 'report_html', 'report_bundle'));

ALTER TABLE "__SCHEMA__".report_revision_outputs DROP CONSTRAINT report_revision_outputs_format_check;
ALTER TABLE "__SCHEMA__".report_revision_outputs ADD CONSTRAINT report_revision_outputs_format_check CHECK (format IN ('html'));
