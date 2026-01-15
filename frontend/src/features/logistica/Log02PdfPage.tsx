export default function Log02PdfPage() {
  return (
    <div className="container-fluid">
      <div className="row">
        <div className="col-12">
          <div className="bd bgc-white p-20 mB-20">
            <h4 className="c-grey-900 mB-10">Filtrado de certificados PDF (LOG-02)</h4>
            <div className="text-muted small">
              Este módulo se orienta a <strong>copiar</strong> y <strong>filtrar</strong> certificados PDF desde una
              <strong> carpeta compartida</strong> (no ZIP).<br />
              Página base creada para iniciar la siguiente fase.
            </div>

            <div className="alert alert-info mT-15" role="alert">
              En construcción: en la siguiente tarea se implementará el flujo de lectura/copiado desde carpeta compartida y
              los filtros de certificados.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
