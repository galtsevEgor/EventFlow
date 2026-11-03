import os

from .database import migrate
from .runtime import run

if __name__ == "__main__":
    run(migrate(os.environ["RECOMMENDATIONS_DATABASE_URL"]))
    print("Recommendations migrations applied.")
