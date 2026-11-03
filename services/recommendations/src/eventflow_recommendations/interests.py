from dataclasses import dataclass


@dataclass(frozen=True)
class Interest:
    id: str
    title: str
    description: str


INTERESTS = (
    Interest("jazz", "Джаз", "Live jazz music concert with saxophone piano and improvisation"),
    Interest("rock", "Рок", "Live rock music concert with electric guitars drums and a band"),
    Interest(
        "classical",
        "Классическая музыка",
        "Classical music symphony orchestra piano violin concert",
    ),
    Interest("electronic", "Электронная музыка", "Electronic music techno dance DJ festival"),
    Interest("theatre", "Театр", "Theatre dramatic play stage performance actors"),
    Interest("comedy", "Стендап и комедия", "Stand up comedy show humour jokes comedians"),
    Interest("cinema", "Кино", "Film cinema movie screening director discussion"),
    Interest("art", "Выставки и искусство", "Art painting sculpture museum exhibition gallery"),
    Interest(
        "technology", "Технологии", "Software technology programming developers conference workshop"
    ),
    Interest("sport", "Спорт", "Sports running football tennis competition match training"),
    Interest("family", "Семейные события", "Family children kids entertainment performance games"),
    Interest("food", "Еда и гастрономия", "Food gastronomy cooking tasting culinary festival"),
)
INTEREST_IDS = frozenset(interest.id for interest in INTERESTS)
