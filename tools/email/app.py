from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel, EmailStr
from typing import List, Optional
import os
import imaplib
import email
from email.header import decode_header
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from email.utils import formataddr
import smtplib
import dotenv
import json
import urllib.request
from datetime import datetime, timedelta
import re
import mimetypes
import tempfile
# 加载环境变量
dotenv.load_dotenv()
dotenv.load_dotenv("asset/.env")
# 全局参数
# 允许接收邮件的发件人白名单
ALLOWED_SENDERS = [
    "939342547@qq.com",
    "1119623207@qq.com", 
    "jiangjimjim@gmail.com"
]
# 邮箱账户配置
EMAIL_ACCOUNT = os.getenv("EMAIL_SENDER", "939342547@qq.com")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")
SMTP_SERVER = "smtp.qq.com"
SMTP_PORT = 465
IMAP_SERVER = "imap.qq.com"
IMAP_PORT = 993
TOOLS_HUB_URL = os.environ.get("TOOLS_HUB_URL", "http://host.docker.internal:19081")

# Email 工具注册信息
EMAIL_TOOL_INFO = {
    "name": "email",
    "display_name": "Email 邮件",
    "description": "SMTP 发信 + IMAP 收件查询服务，支持白名单过滤、附件发送",
    "doc_md": """# Email 邮件服务

## 功能概览

| 功能 | 说明 |
|------|------|
| 发送邮件 | SMTP (QQ邮箱) 发送纯文本/附件邮件 |
| 查询邮件 | IMAP 拉取白名单发件人的最近邮件 |
| 白名单过滤 | 仅返回白名单发件人的邮件，保障安全 |
| 附件上传 | 支持 FormData 上传附件后发送 |
| FormData 发送 | `/send-email-with-files/` 端点支持文件和表单混合提交 |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务信息 + 白名单 |
| GET | `/emails/` | 查询白名单发件人的邮件（limit/days 参数） |
| POST | `/send-email/` | 发送纯文本邮件（JSON body） |
| POST | `/send-email-with-files/` | 发送带附件邮件（FormData） |
| GET | `/allowed-senders/` | 获取白名单发件人列表 |

## 使用示例

```bash
# 查询最近邮件
curl "http://dimond.top:19001/emails/?limit=5&days=3"

# 发送邮件
curl -X POST http://dimond.top:19001/send-email/ \\
  -H "Content-Type: application/json" \\
  -d '{"to":"user@example.com","subject":"Hello","body":"Test"}'
```
"""
}

def register_tool():
    """向 19081 Hub 注册本工具"""
    try:
        data = json.dumps(EMAIL_TOOL_INFO).encode("utf-8")
        req = urllib.request.Request(
            f"{TOOLS_HUB_URL}/api/tools",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=10)
        print("[register] Email tool registered", flush=True)
    except Exception as e:
        print(f"[register] WARNING: tool registration failed: {e}", flush=True)
# Pydantic模型定义
class EmailItem(BaseModel):
    id: str
    subject: str
    sender: str
    date: Optional[str] = None
    body: str
    attachments: Optional[List[str]] = None
class SendEmailRequest(BaseModel):
    to: EmailStr
    subject: str
    body: str
    attachments: Optional[List[str]] = None
class SendEmailResponse(BaseModel):
    success: bool
    message: str
# 初始化FastAPI应用
app = FastAPI(
    title="Email Service API",
    description="API for receiving emails from allowed senders and sending emails",
    version="1.0.0"
)
def get_emails_from_allowed_senders(
    limit: int = 10,
    days: int = 7
) -> List[EmailItem]:
    """
    从允许的发件人接收邮件
    """
    if not EMAIL_ACCOUNT or not EMAIL_PASSWORD:
        print("Error: EMAIL_SENDER or EMAIL_PASSWORD environment variables not set.")
        return []
    
    try:
        # 连接到邮箱服务器
        mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
        mail.login(EMAIL_ACCOUNT, EMAIL_PASSWORD)
        
        # 选择收件箱
        mail.select('inbox')
        
        # 搜索最近的邮件
        since_date = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
        typ, data = mail.search(None, f'SINCE {since_date}')
        
        email_ids = data[0].split()
        # 限制邮件数量
        email_ids = email_ids[-limit:] if len(email_ids) > limit else email_ids
        
        emails = []
        
        for email_id in reversed(email_ids):  # 最新的邮件在前
            typ, msg_data = mail.fetch(email_id, '(RFC822)')
            raw_email = msg_data[0][1]
            msg = email.message_from_bytes(raw_email)
            
            # 解码邮件主题
            subject = decode_header(msg['Subject'])[0][0]
            if isinstance(subject, bytes):
                subject = subject.decode()
            
            # 获取发件人
            sender = msg['From']
            # 提取邮箱地址
            sender_addr_match = re.search(r'<(.*)>', sender)
            if sender_addr_match:
                sender_addr = sender_addr_match.group(1)
            else:
                sender_addr = sender.strip('"')
            
            # 检查发件人是否在白名单中
            if sender_addr in ALLOWED_SENDERS:
                # 获取邮件正文与附件
                body = ""
                attachments: List[str] = []
                if msg.is_multipart():
                    for part in msg.walk():
                        content_type = part.get_content_type()
                        content_disposition = str(part.get("Content-Disposition"))
                        if content_type == "text/plain" and "attachment" not in content_disposition and not body:
                            body = part.get_payload(decode=True).decode()
                        # 收集附件文件名（可选）
                        if "attachment" in content_disposition:
                            filename = part.get_filename()
                            if filename:
                                try:
                                    decoded = decode_header(filename)
                                    name_part = decoded[0][0]
                                    if isinstance(name_part, bytes):
                                        name_part = name_part.decode(errors="ignore")
                                    attachments.append(str(name_part))
                                except Exception:
                                    attachments.append(str(filename))
                else:
                    body = msg.get_payload(decode=True).decode()
                
                # 仅返回具备标题与正文的邮件
                if (subject is not None and str(subject).strip()) and (body is not None and str(body).strip()):
                    email_info = EmailItem(
                        id=email_id.decode(),
                        subject=str(subject),
                        sender=sender_addr,
                        date=msg['Date'],
                        body=body[:500] + "..." if len(body) > 500 else body,  # 限制长度
                        attachments=attachments or None
                    )
                    emails.append(email_info)
        
        mail.close()
        mail.logout()
        
        return emails
        
    except Exception as e:
        print(f"Failed to retrieve emails: {e}")
        return []
def send_email(to_email: str, subject: str, body: str, attachments: Optional[List[str]] = None) -> dict:
    """
    发送邮件的函数
    """
    # 标题与正文必填校验
    if not str(subject).strip() or not str(body).strip():
        return {"success": False, "message": "subject 与 body 为必填项"}
    
    # 获取配置
    sender_email = os.getenv("EMAIL_SENDER")
    sender_password = os.getenv("EMAIL_PASSWORD")
    
    if not sender_email or not sender_password:
        return {
            "success": False,
            "message": "EMAIL_SENDER or EMAIL_PASSWORD environment variables not set."
        }
    
    try:
        # 构建邮件
        msg = MIMEMultipart()
        msg["Subject"] = subject
        msg["From"] = formataddr(("OpenClaw Email Service", sender_email))
        msg["To"] = to_email
        
        # 添加正文
        msg.attach(MIMEText(body, "plain", "utf-8"))
        # 添加附件（可选）
        if attachments:
            for file_path in attachments:
                if not file_path:
                    continue
                if not os.path.exists(file_path):
                    # 跳过不存在的附件
                    continue
                try:
                    with open(file_path, "rb") as f:
                        file_data = f.read()
                        file_name = os.path.basename(file_path)
                    mime_type, _ = mimetypes.guess_type(file_path)
                    if mime_type is None:
                        mime_type = "application/octet-stream"
                    part = MIMEApplication(file_data, Name=file_name)
                    part["Content-Disposition"] = f'attachment; filename="{file_name}"'
                    msg.attach(part)
                except Exception:
                    # 单个附件失败不影响整体发送
                    continue
        
        # 发送邮件
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
            server.login(sender_email, sender_password)
            server.send_message(msg)
        
        return {
            "success": True,
            "message": f"Email sent successfully to {to_email}"
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Failed to send email: {str(e)}"
        }
@app.get("/")
async def root():
    """根路径，返回API信息"""
    return {
        "message": "Welcome to Email Service API",
        "description": "API for receiving emails from allowed senders and sending emails",
        "allowed_senders": ALLOWED_SENDERS
    }
@app.get("/emails/", response_model=List[EmailItem])
async def get_emails(
    limit: int = Query(10, ge=1, le=100, description="Maximum number of emails to retrieve"),
    days: int = Query(7, ge=1, le=30, description="Number of recent days to check")
):
    """
    获取来自白名单发件人的邮件
    """
    emails = get_emails_from_allowed_senders(limit=limit, days=days)
    return emails
@app.post("/send-email/", response_model=SendEmailResponse)
async def send_email_endpoint(request: SendEmailRequest):
    """
    发送邮件到指定邮箱（允许任意收件人；标题与正文必填，附件可选）
    """
    result = send_email(request.to, request.subject, request.body, request.attachments)
    
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    
    return SendEmailResponse(success=True, message=result["message"])
@app.get("/allowed-senders/")
async def get_allowed_senders():
    """
    获取允许的发件人列表
    """
    return {"allowed_senders": ALLOWED_SENDERS}
@app.post("/send-email-with-files/", response_model=SendEmailResponse)
async def send_email_with_files(
    to: str = Form(...),
    subject: str = Form(...),
    body: str = Form(...),
    files: Optional[List[UploadFile]] = File(None)
):
    """发送邮件，支持Form Data上传附件"""
    if not subject.strip() or not body.strip():
        raise HTTPException(status_code=400, detail="subject和body为必填项")
    
    sender_email = os.getenv("EMAIL_SENDER")
    sender_password = os.getenv("EMAIL_PASSWORD")
    if not sender_email or not sender_password:
        raise HTTPException(status_code=400, detail="EMAIL_SENDER或EMAIL_PASSWORD未设置")
    
    temp_files = []
    try:
        if files:
            temp_dir = tempfile.mkdtemp()
            for f in files:
                if f.filename:
                    file_path = os.path.join(temp_dir, f.filename)
                    content = await f.read()
                    with open(file_path, 'wb') as pf:
                        pf.write(content)
                    temp_files.append(file_path)
        
        result = send_email(to, subject, body, temp_files if temp_files else None)
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result["message"])
        return SendEmailResponse(success=True, message=result["message"])
    finally:
        for fp in temp_files:
            try:
                os.remove(fp)
            except:
                pass
        if temp_files:
            try:
                os.rmdir(os.path.dirname(temp_files[0]))
            except:
                pass
if __name__ == "__main__":
    import uvicorn
    register_tool()
    uvicorn.run(app, host="0.0.0.0", port=8082)
