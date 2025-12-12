import { Link } from "react-router-dom";

export default function ConsolidacionOisPage() {
  return (
    <div className="container-fluid">
      <div className="bgc-white p-20 bd">
        <h4 className="c-grey-900 mB-10">Consolidación de Bases Originales</h4>
        <p className="text-muted mB-20">
          Selecciona el modo de consolidación. Cada modo genera un archivo consolidado para descarga.
        </p>

        <div className="row">
          <div className="col-md-6 mB-15">
            <div className="card h-100">
              <div className="card-body">
                <h5 className="card-title">Correlativo</h5>
                <p className="card-text text-muted">
                  Ordena por la columna G (correlativo) al consolidar.
                </p>
                <Link className="btn btn-primary" to="/oi/tools/consolidacion/correlativo">
                  Abrir
                </Link>
              </div>
            </div>
          </div>

          <div className="col-md-6 mB-15">
            <div className="card h-100">
              <div className="card-body">
                <h5 className="card-title">No correlativo</h5>
                <p className="card-text text-muted">
                  Mantiene el orden original de los archivos al consolidar.
                </p>
                <Link className="btn btn-primary" to="/oi/tools/consolidacion/no-correlativo">
                  Abrir
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

