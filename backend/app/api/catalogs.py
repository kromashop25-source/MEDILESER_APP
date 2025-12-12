from fastapi import APIRouter

router = APIRouter()

@router.get("")
def get_catalogs():
    return {
        "q3": [1.6, 2.5, 4.0, 6.3],
        "alcance": [ 100, 125, 160, 200, 400, 500],
        # PMA: solo en el formulario (no desplegable dentro del Excel)
        "pma": [10, 16],
        "bancos": [{"id": 3, "name": "Banco 3"}, {"id": 4, "name": "Banco 4"}, 
                   {"id": 5, "name": "Banco 5"},{"id": 6, "name": "Banco 6"},],
    }
