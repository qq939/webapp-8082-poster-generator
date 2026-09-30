import os
import imaplib
import email
from email.header import decode_header
from typing import List, Optional
import dotenv
from datetime import datetime, timedelta
# 加载环境变量
dotenv.load_dotenv()
dotenv.load_dotenv("asset/.env")
# 全局参数
# 允许接收邮件的发件人白名单
ALLOWED_SENDERS = [
    "939342547@qq.com",
    "1119623207@qq.com", 
    "jiangjimjim@gmail.com"
]  # 使用位置: check_email 函数中验证发件人
# 默认邮箱账户配置
DEFAULT_EMAIL = os.getenv("EMAIL_SENDER", "939342547@qq.com")
DEFAULT_PASSWORD = os.getenv("EMAIL_PASSWORD")
DEFAULT_IMAP_SERVER = "imap.qq.com"  # QQ邮箱IMAP服务器
DEFAULT_IMAP_PORT = 993             # SSL端口
def get_emails_from_allowed_senders(
    limit: int = 10,
    days: int = 7
) -> List[dict]:
    """
    从允许的发件人接收邮件
    
    Args:
        limit: 获取邮件的最大数量
        days: 获取最近几天的邮件
        
    Returns:
        List[dict]: 包含邮件信息的字典列表
    """
    if not DEFAULT_EMAIL or not DEFAULT_PASSWORD:
        print("Error: EMAIL_SENDER or EMAIL_PASSWORD environment variables not set.")
        return []
    
    try:
        # 连接到邮箱服务器
        mail = imaplib.IMAP4_SSL(DEFAULT_IMAP_SERVER, DEFAULT_IMAP_PORT)
        mail.login(DEFAULT_EMAIL, DEFAULT_PASSWORD)
        
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
            import re
            sender_addr_match = re.search(r'<(.*)>', sender)
            if sender_addr_match:
                sender_addr = sender_addr_match.group(1)
            else:
                sender_addr = sender.strip('"')
            
            # 检查发件人是否在白名单中
            if sender_addr in ALLOWED_SENDERS:
                # 获取邮件正文
                body = ""
                if msg.is_multipart():
                    for part in msg.walk():
                        content_type = part.get_content_type()
                        content_disposition = str(part.get("Content-Disposition"))
                        
                        if content_type == "text/plain" and "attachment" not in content_disposition:
                            body = part.get_payload(decode=True).decode()
                            break
                else:
                    body = msg.get_payload(decode=True).decode()
                
                email_info = {
                    'id': email_id.decode(),
                    'subject': subject,
                    'sender': sender_addr,
                    'date': msg['Date'],
                    'body': body[:500] + "..." if len(body) > 500 else body  # 限制长度
                }
                emails.append(email_info)
        
        mail.close()
        mail.logout()
        
        return emails
        
    except Exception as e:
        print(f"Failed to retrieve emails: {e}")
        return []
def print_emails_from_allowed_senders(limit: int = 10, days: int = 7):
    """
    打印来自白名单发件人的邮件
    """
    emails = get_emails_from_allowed_senders(limit, days)
    
    if not emails:
        print("No emails found from allowed senders.")
        return
    
    print(f"Found {len(emails)} emails from allowed senders:")
    print("="*50)
    
    for i, email_info in enumerate(emails, 1):
        print(f"{i}. Subject: {email_info['subject']}")
        print(f"   From: {email_info['sender']}")
        print(f"   Date: {email_info['date']}")
        print(f"   Body Preview: {email_info['body']}")
        print("-" * 30)
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        if sys.argv[1] == "--help" or sys.argv[1] == "-h":
            print("Usage: python email_receiver.py [limit] [days]")
            print("  limit: Maximum number of emails to retrieve (default: 10)")
            print("  days: Number of recent days to check (default: 7)")
            print("Example: python email_receiver.py 20 14")
        else:
            limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10
            days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
            print_emails_from_allowed_senders(limit, days)
    else:
        print_emails_from_allowed_senders()  # 默认获取最近7天的最多10封邮件
