from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from hashlib import sha256

bearer_scheme = HTTPBearer(auto_error=False)

def get_password_hash(password: str) -> str:
    """Devuelve un hash simple (sha256) para la contraseña en texto plano.

    Para producción se debería usar bcrypt/argon2, pero para los usuarios
    de prueba es suficiente.
    """
    return sha256(password.encode("utf-8")).hexdigest()


def verify_password(plain_password: str, password_hash: str) -> bool:
    """Compara una contraseña en texto plano contra su hash almacenado."""
    return get_password_hash(plain_password) == password_hash


def get_current_user(credentials:HTTPAuthorizationCredentials = Depends(bearer_scheme)):
    """ Stub de autenticación: valida que llegue un Bearer token.
        Reemplazar por JWT real más adelante.
    """
    if not credentials or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    # TODO: decodificar/valida token y retornar el usuario real
    return {"username": "demo", "techNumber": "T-000", "bancoId": 1}
    
