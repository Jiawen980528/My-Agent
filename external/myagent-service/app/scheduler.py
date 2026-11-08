from datetime import datetime, timezone
from apscheduler.schedulers.background import BackgroundScheduler
from . import db
from .modules import quant_news
scheduler = BackgroundScheduler(daemon=True)

def tick():
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    for task in db.due_tasks(now):
        msg = f"Reminder due: {task['title']} (task_id={task['id']})"
        db.finish_task(task["id"], msg)
        db.log_event("INFO","reminder_due",msg)

def start_scheduler():
    db.restore_incomplete_tasks()
    if not scheduler.running:
        scheduler.add_job(tick,"interval",seconds=20,id="task_tick",replace_existing=True)
        scheduler.add_job(quant_news.refresh_news,"interval",minutes=5,id="quant_news_refresh",replace_existing=True,
                          max_instances=1,coalesce=True,next_run_time=datetime.now(timezone.utc))
        scheduler.start()

def stop_scheduler():
    if scheduler.running: scheduler.shutdown(wait=False)
